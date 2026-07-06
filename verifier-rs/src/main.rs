//! verify-vh — an INDEPENDENT, offline verifyhash evidence-seal verifier.
//!
//! A clean-room Rust re-implementation of the `verify-vh` evidence-seal path,
//! written against SPEC.md. It re-derives the keccak Merkle root from the bytes
//! you hold (never trusting the artifact's stored hashes), recovers the EIP-191
//! signer with a hand-rolled secp256k1 routine, and prints a deterministic
//! ACCEPT/REJECT verdict.
//!
//! ZERO external crates: keccak256, 256-bit modular arithmetic, secp256k1
//! recovery, and JSON parsing are all implemented in pure Rust in this crate.
//!
//! Exit contract (identical to verify-vh):
//!   0  OK        artifact ACCEPTED
//!   3  REJECTED  clean negative verdict
//!   2  USAGE     bad CLI usage / malformed --vendor / unrecognized kind
//!   1  IO        cannot read artifact / not JSON / structurally malformed seal

mod field;
mod json;
mod keccak;
mod merkle;
mod secp256k1;

use json::Value;
use keccak::keccak256;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const EXIT_OK: u8 = 0;
const EXIT_IO: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_REJECTED: u8 = 3;

const EVIDENCE_SEAL: &str = "vh.evidence-seal";
const EVIDENCE_SEAL_SIGNED: &str = "vh.evidence-seal-signed";

const TRUST_NOTE: &str = "verify-vh is an INDEPENDENT, read-only, OFFLINE verifier. It RE-DERIVES the keccak root from the bytes you hold and recovers the signer with no producer stack. It proves TAMPER-EVIDENCE + WHO vouched — NOT a trusted timestamp and NOT a legal opinion.";

const USAGE: &str = "usage: verify-vh <artifact> [--vendor <0xaddr>] [--dir <d>] [--json]";

// ---------------------------------------------------------------------------
// Errors: Usage -> exit 2, Io -> exit 1. A REJECTED verdict is NOT an error.
// ---------------------------------------------------------------------------

enum VhError {
    Usage(String),
    Io(String),
}

// ---------------------------------------------------------------------------
// Small hex helpers.
// ---------------------------------------------------------------------------

fn bytes_to_hex0x(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for &b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn keccak_hex(data: &[u8]) -> String {
    bytes_to_hex0x(&keccak256(data))
}

fn is_hex32(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_sig65(s: &str) -> bool {
    s.len() == 132 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn hex0x_to_bytes(s: &str) -> Option<Vec<u8>> {
    let h = s.strip_prefix("0x")?;
    if h.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(h.len() / 2);
    let b = h.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Confined file source: escaped / missing / ok — never hash outside baseDir.
// ---------------------------------------------------------------------------

enum ReadStatus {
    Ok(Vec<u8>),
    Missing,
    Escaped,
}

fn read_entry(base_dir: &Path, rel_path: &str) -> ReadStatus {
    // (1) String-level confinement before any filesystem access.
    if rel_path.is_empty() {
        return ReadStatus::Escaped;
    }
    if Path::new(rel_path).is_absolute() {
        return ReadStatus::Escaped;
    }
    // Split on both '/' and '\\'; any ".." component is hostile.
    if rel_path
        .split(|c| c == '/' || c == '\\')
        .any(|comp| comp == "..")
    {
        return ReadStatus::Escaped;
    }

    let full = base_dir.join(rel_path);
    let data = match std::fs::read(&full) {
        Ok(d) => d,
        Err(_) => return ReadStatus::Missing,
    };

    // (2) Post-open realpath confinement: refuse out-of-tree symlinks.
    if let (Ok(cbase), Ok(cfull)) = (std::fs::canonicalize(base_dir), std::fs::canonicalize(&full))
    {
        if !cfull.starts_with(&cbase) {
            return ReadStatus::Escaped;
        }
    }
    ReadStatus::Ok(data)
}

// ---------------------------------------------------------------------------
// File classification + Merkle re-derivation.
// ---------------------------------------------------------------------------

struct ChangedEntry {
    rel_path: String,
    expected: String,
    actual: String,
}

struct FileResult {
    matched: Vec<(String, String)>, // (relPath, contentHash)
    changed: Vec<ChangedEntry>,
    missing: Vec<String>,
    escaped: Vec<String>,
    sealed_root: String,
    recomputed_root: Option<String>,
    root_matches: bool,
    files_ok: bool,
}

fn verify_evidence_seal(seal: &Value, base_dir: &Path) -> Result<FileResult, VhError> {
    let files = seal
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| VhError::Io("evidence seal `files` must be a non-empty array".into()))?;
    if files.is_empty() {
        return Err(VhError::Io(
            "evidence seal `files` must be a non-empty array".into(),
        ));
    }

    let root = seal
        .get("root")
        .and_then(Value::as_str)
        .filter(|r| is_hex32(r))
        .ok_or_else(|| {
            VhError::Io("evidence seal `root` must be a 0x-prefixed 32-byte hex string".into())
        })?
        .to_string();

    let mut matched = Vec::new();
    let mut changed = Vec::new();
    let mut missing = Vec::new();
    let mut escaped = Vec::new();
    let mut flat: Vec<(String, [u8; 32])> = Vec::new();

    for entry in files {
        let rel_path = entry
            .get("relPath")
            .and_then(Value::as_str)
            .ok_or_else(|| VhError::Io("evidence seal file entry missing `relPath`".into()))?;
        let content_hash = entry
            .get("contentHash")
            .and_then(Value::as_str)
            .ok_or_else(|| VhError::Io("evidence seal file entry missing `contentHash`".into()))?;

        match read_entry(base_dir, rel_path) {
            ReadStatus::Escaped => escaped.push(rel_path.to_string()),
            ReadStatus::Missing => missing.push(rel_path.to_string()),
            ReadStatus::Ok(data) => {
                let digest = keccak256(&data);
                flat.push((rel_path.to_string(), digest));
                let actual = bytes_to_hex0x(&digest);
                if actual.eq_ignore_ascii_case(content_hash) {
                    matched.push((rel_path.to_string(), actual));
                } else {
                    changed.push(ChangedEntry {
                        rel_path: rel_path.to_string(),
                        expected: content_hash.to_string(),
                        actual,
                    });
                }
            }
        }
    }

    let recomputed_root = if flat.is_empty() {
        None
    } else {
        merkle::root_from_flat(&flat).map(|r| bytes_to_hex0x(&r))
    };

    let root_matches = missing.is_empty()
        && changed.is_empty()
        && escaped.is_empty()
        && recomputed_root
            .as_deref()
            .map(|r| r.eq_ignore_ascii_case(&root))
            .unwrap_or(false);

    let files_ok = changed.is_empty() && missing.is_empty() && escaped.is_empty() && root_matches;

    Ok(FileResult {
        matched,
        changed,
        missing,
        escaped,
        sealed_root: root,
        recomputed_root,
        root_matches,
        files_ok,
    })
}

// ---------------------------------------------------------------------------
// Signed-container decoding.
// ---------------------------------------------------------------------------

struct SignedDecode {
    embedded: Value,
    message: Vec<u8>, // the attestation string verbatim, as UTF-8 bytes
    claimed_signer: String,
    signature: String,
}

fn decode_signed(container: &Value) -> Result<SignedDecode, VhError> {
    let sig = container.get("signature").filter(|v| v.is_object()).ok_or_else(|| {
        VhError::Io("signed artifact is missing a { scheme, signer, signature } signature block".into())
    })?;

    match sig.get("scheme").and_then(Value::as_str) {
        Some("eip191-personal-sign") => {}
        other => {
            return Err(VhError::Io(format!(
                "unsupported signature scheme: {:?} (this verifier understands eip191-personal-sign)",
                other
            )));
        }
    }

    let attestation = container
        .get("attestation")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            VhError::Io(
                "signed artifact must embed the canonical UNSIGNED bytes as a string `attestation`"
                    .into(),
            )
        })?;

    let signature = sig
        .get("signature")
        .and_then(Value::as_str)
        .filter(|s| is_sig65(s))
        .ok_or_else(|| {
            VhError::Io("signed artifact signature must be a 65-byte (r||s||v) 0x-hex string".into())
        })?
        .to_string();

    let signer = sig
        .get("signer")
        .and_then(Value::as_str)
        .filter(|s| is_address(s))
        .ok_or_else(|| {
            VhError::Io("signed artifact signer must be a 0x-prefixed 20-byte hex address".into())
        })?;

    let embedded = json::parse(attestation)
        .map_err(|e| VhError::Io(format!("embedded attestation is not valid JSON: {}", e)))?;

    Ok(SignedDecode {
        embedded,
        message: attestation.as_bytes().to_vec(),
        claimed_signer: signer.to_lowercase(),
        signature,
    })
}

// ---------------------------------------------------------------------------
// The full verify result (for both human + JSON rendering).
// ---------------------------------------------------------------------------

struct VerifyResult {
    artifact: String,
    kind: String,
    payload_kind: Option<String>,
    signed: bool,
    reason: String,
    accepted: bool,
    recovered_signer: Option<String>,
    claimed_signer: Option<String>,
    pinned_vendor: Option<String>,
    signature_ok: Option<bool>,
    signer_matches_vendor: Option<bool>,
    sealed_root: Option<String>,
    recomputed_root: Option<String>,
    root_matches: Option<bool>,
    matched: Vec<(String, String)>,
    changed: Vec<ChangedEntry>,
    missing: Vec<String>,
    escaped: Vec<String>,
}

fn normalize_address(addr: &str, label: &str) -> Result<String, VhError> {
    if is_address(addr) {
        Ok(addr.to_lowercase())
    } else {
        Err(VhError::Usage(format!(
            "{} must be a 0x-prefixed 20-byte hex address, got: {}",
            label, addr
        )))
    }
}

fn verify_parsed_artifact(
    artifact_name: &str,
    obj: &Value,
    vendor: Option<&str>,
    base_dir: &Path,
) -> Result<(VerifyResult, u8), VhError> {
    let kind_str = obj
        .get("kind")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let pinned = match vendor {
        Some(v) => Some(normalize_address(v, "--vendor")?),
        None => None,
    };

    let mut signed = false;
    let mut recovered_signer: Option<String> = None;
    let mut claimed_signer: Option<String> = None;
    let mut signature_ok: Option<bool> = None;

    let payload: &Value;
    let payload_kind: Option<String>;
    let decoded;

    match kind_str.as_deref() {
        Some(EVIDENCE_SEAL_SIGNED) => {
            signed = true;
            decoded = decode_signed(obj)?;
            payload = &decoded.embedded;
            payload_kind = payload.get("kind").and_then(Value::as_str).map(String::from);
            claimed_signer = Some(decoded.claimed_signer.clone());
            let recovered = match hex0x_to_bytes(&decoded.signature) {
                Some(sig_bytes) => {
                    secp256k1::recover_personal_sign(&decoded.message, &sig_bytes)
                }
                None => None,
            };
            signature_ok = Some(
                recovered
                    .as_deref()
                    .map(|r| Some(r) == claimed_signer.as_deref())
                    .unwrap_or(false),
            );
            recovered_signer = recovered;
        }
        Some(EVIDENCE_SEAL) => {
            payload = obj;
            payload_kind = Some(EVIDENCE_SEAL.to_string());
        }
        other => {
            return Err(VhError::Usage(format!(
                "unrecognized artifact kind: {:?} (verify-vh understands evidence seals, \
                 reconciliation seals, dataset attestations, and proof bundles)",
                other
            )));
        }
    }

    if payload_kind.as_deref() != Some(EVIDENCE_SEAL) {
        return Err(VhError::Usage(format!(
            "unrecognized embedded artifact kind: {:?}",
            payload_kind
        )));
    }

    let file_result = verify_evidence_seal(payload, base_dir)?;

    let mut reason = String::from("OK");
    let mut accepted = true;

    if !file_result.files_ok {
        accepted = false;
        reason = if !file_result.escaped.is_empty() {
            "path_escape"
        } else if !file_result.changed.is_empty() {
            "CHANGED"
        } else if !file_result.missing.is_empty() {
            "MISSING"
        } else {
            "root_mismatch"
        }
        .to_string();
    }

    let mut signer_matches_vendor: Option<bool> = None;
    if signed {
        if signature_ok != Some(true) {
            accepted = false;
            reason = "bad_signature".to_string();
        } else if let Some(ref pin) = pinned {
            let matches = recovered_signer.as_deref() == Some(pin.as_str());
            signer_matches_vendor = Some(matches);
            if !matches {
                accepted = false;
                if file_result.files_ok || reason == "OK" {
                    reason = "wrong_issuer".to_string();
                }
            }
        }
    } else if pinned.is_some() {
        accepted = false;
        reason = "unsigned_cannot_pin_vendor".to_string();
    }

    let code = if accepted { EXIT_OK } else { EXIT_REJECTED };

    let result = VerifyResult {
        artifact: artifact_name.to_string(),
        kind: kind_str.unwrap_or_else(|| "null".to_string()),
        payload_kind,
        signed,
        reason,
        accepted,
        recovered_signer,
        claimed_signer,
        pinned_vendor: pinned,
        signature_ok,
        signer_matches_vendor,
        sealed_root: Some(file_result.sealed_root),
        recomputed_root: file_result.recomputed_root,
        root_matches: Some(file_result.root_matches),
        matched: file_result.matched,
        changed: file_result.changed,
        missing: file_result.missing,
        escaped: file_result.escaped,
    };
    Ok((result, code))
}

fn verify_artifact(opts: &Opts) -> Result<(VerifyResult, u8), VhError> {
    let artifact = opts
        .artifact
        .as_ref()
        .ok_or_else(|| VhError::Usage("verify-vh requires an <artifact>".into()))?;

    let artifact_path = std::fs::canonicalize(artifact)
        .unwrap_or_else(|_| PathBuf::from(artifact));

    let text = std::fs::read_to_string(&artifact_path)
        .map_err(|e| VhError::Io(format!("cannot read artifact {}: {}", artifact, e)))?;

    let obj = json::parse(&text)
        .map_err(|e| VhError::Io(format!("artifact {} is not valid JSON: {}", artifact, e)))?;
    if !obj.is_object() {
        return Err(VhError::Io(format!(
            "artifact {} must be a JSON object",
            artifact
        )));
    }

    let base_dir: PathBuf = match &opts.dir {
        Some(d) => PathBuf::from(d),
        None => artifact_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".")),
    };

    verify_parsed_artifact(artifact, &obj, opts.vendor.as_deref(), &base_dir)
}

// ---------------------------------------------------------------------------
// Human + JSON rendering.
// ---------------------------------------------------------------------------

fn render_human(r: &VerifyResult) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(TRUST_NOTE.to_string());
    lines.push(String::new());
    lines.push(format!("# verify-vh — {}", r.artifact));
    lines.push(format!("kind:            {}", r.kind));
    if r.payload_kind.as_deref() != Some(r.kind.as_str()) {
        lines.push(format!(
            "embedded kind:   {}",
            r.payload_kind.as_deref().unwrap_or("null")
        ));
    }
    lines.push(format!("signed:          {}", if r.signed { "yes" } else { "no" }));

    if r.signed {
        match &r.recovered_signer {
            Some(s) => lines.push(format!("recovered signer: {}", s)),
            None => lines.push("recovered signer: (unrecoverable)".to_string()),
        }
        lines.push(format!(
            "claimed signer:  {}",
            r.claimed_signer.as_deref().unwrap_or("")
        ));
        if let Some(pin) = &r.pinned_vendor {
            lines.push(format!("pinned --vendor: {}", pin));
            lines.push(format!(
                "signer matches vendor: {}",
                if r.signer_matches_vendor == Some(true) {
                    "yes"
                } else {
                    "NO"
                }
            ));
        } else {
            lines.push(
                "(no --vendor pin: the recovered signer above is reported, not pinned)".to_string(),
            );
        }
    } else if r.recovered_signer.is_none() && r.pinned_vendor.is_some() {
        lines.push(
            "note: --vendor was supplied but this artifact is UNSIGNED (no signer to pin)"
                .to_string(),
        );
    }

    if let Some(root) = &r.sealed_root {
        lines.push(format!("sealed root:     {}", root));
    }
    if let Some(root) = &r.recomputed_root {
        lines.push(format!("recomputed root: {}", root));
    }
    if let Some(rm) = r.root_matches {
        lines.push(format!("root matches:    {}", if rm { "yes" } else { "NO" }));
    }
    lines.push(format!(
        "files: {} matched, {} changed, {} missing, {} rejected, 0 unexpected",
        r.matched.len(),
        r.changed.len(),
        r.missing.len(),
        r.escaped.len()
    ));
    lines.push(String::new());

    if r.accepted {
        lines.push("OK — the artifact verifies.".to_string());
    } else {
        lines.push(format!("REJECTED ({}):", r.reason));
        for ch in &r.changed {
            lines.push(format!(
                "  CHANGED    {}: sealed {} != on-disk {}",
                ch.rel_path, ch.expected, ch.actual
            ));
        }
        for m in &r.missing {
            lines.push(format!("  MISSING    {}: referenced but not found on disk", m));
        }
        for x in &r.escaped {
            lines.push(format!(
                "  REJECTED   {}: path escapes the artifact directory (refused to read; no hash computed)",
                x
            ));
        }
        match r.reason.as_str() {
            "bad_signature" => lines.push(
                "  bad_signature: the signature does not recover to the claimed signer (tampered or forged)."
                    .to_string(),
            ),
            "wrong_issuer" => lines.push(format!(
                "  wrong_issuer: recovered {} but you pinned --vendor {}.",
                r.recovered_signer.as_deref().unwrap_or("null"),
                r.pinned_vendor.as_deref().unwrap_or("null")
            )),
            "unsigned_cannot_pin_vendor" => lines.push(
                "  --vendor was pinned but the artifact carries no signature to recover a signer from."
                    .to_string(),
            ),
            "root_mismatch" => lines.push(
                "  root_mismatch: the recomputed root does not equal the sealed root.".to_string(),
            ),
            "path_escape" => lines.push(
                "  path_escape: the artifact references a file OUTSIDE its own directory (absolute path, `..` traversal, or an out-of-tree symlink). A genuine artifact never does this; refused to read it."
                    .to_string(),
            ),
            _ => {}
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn opt_str_json(v: &Option<String>) -> String {
    match v {
        Some(s) => format!("\"{}\"", json_escape(s)),
        None => "null".to_string(),
    }
}

fn opt_bool_json(v: &Option<bool>) -> String {
    match v {
        Some(b) => b.to_string(),
        None => "null".to_string(),
    }
}

fn render_json(r: &VerifyResult) -> String {
    let mut s = String::new();
    s.push_str("{\n");
    s.push_str(&format!("  \"artifact\": \"{}\",\n", json_escape(&r.artifact)));
    s.push_str(&format!("  \"kind\": \"{}\",\n", json_escape(&r.kind)));
    s.push_str(&format!("  \"payloadKind\": {},\n", opt_str_json(&r.payload_kind)));
    s.push_str(&format!("  \"signed\": {},\n", r.signed));
    s.push_str(&format!(
        "  \"verdict\": \"{}\",\n",
        if r.accepted { "OK" } else { "REJECTED" }
    ));
    s.push_str(&format!("  \"reason\": \"{}\",\n", json_escape(&r.reason)));
    s.push_str(&format!("  \"accepted\": {},\n", r.accepted));
    s.push_str(&format!("  \"recoveredSigner\": {},\n", opt_str_json(&r.recovered_signer)));
    s.push_str(&format!("  \"claimedSigner\": {},\n", opt_str_json(&r.claimed_signer)));
    s.push_str(&format!("  \"pinnedVendor\": {},\n", opt_str_json(&r.pinned_vendor)));
    s.push_str(&format!("  \"signatureOk\": {},\n", opt_bool_json(&r.signature_ok)));
    s.push_str(&format!(
        "  \"signerMatchesVendor\": {},\n",
        opt_bool_json(&r.signer_matches_vendor)
    ));
    s.push_str(&format!("  \"sealedRoot\": {},\n", opt_str_json(&r.sealed_root)));
    s.push_str(&format!("  \"recomputedRoot\": {},\n", opt_str_json(&r.recomputed_root)));
    s.push_str(&format!("  \"rootMatches\": {},\n", opt_bool_json(&r.root_matches)));
    s.push_str("  \"counts\": {\n");
    s.push_str(&format!("    \"matched\": {},\n", r.matched.len()));
    s.push_str(&format!("    \"changed\": {},\n", r.changed.len()));
    s.push_str(&format!("    \"missing\": {},\n", r.missing.len()));
    s.push_str(&format!("    \"escaped\": {},\n", r.escaped.len()));
    s.push_str("    \"unexpected\": 0\n");
    s.push_str("  },\n");

    // matched[]
    s.push_str("  \"matched\": [");
    for (i, (rel, ch)) in r.matched.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "\n    {{ \"relPath\": \"{}\", \"contentHash\": \"{}\" }}",
            json_escape(rel),
            json_escape(ch)
        ));
    }
    s.push_str(if r.matched.is_empty() { "],\n" } else { "\n  ],\n" });

    // changed[]
    s.push_str("  \"changed\": [");
    for (i, ch) in r.changed.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "\n    {{ \"relPath\": \"{}\", \"expectedContentHash\": \"{}\", \"actualContentHash\": \"{}\" }}",
            json_escape(&ch.rel_path),
            json_escape(&ch.expected),
            json_escape(&ch.actual)
        ));
    }
    s.push_str(if r.changed.is_empty() { "],\n" } else { "\n  ],\n" });

    // missing[]
    s.push_str("  \"missing\": [");
    for (i, m) in r.missing.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("\n    {{ \"relPath\": \"{}\" }}", json_escape(m)));
    }
    s.push_str(if r.missing.is_empty() { "],\n" } else { "\n  ],\n" });

    // escaped[]
    s.push_str("  \"escaped\": [");
    for (i, x) in r.escaped.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("\n    {{ \"relPath\": \"{}\" }}", json_escape(x)));
    }
    s.push_str(if r.escaped.is_empty() { "],\n" } else { "\n  ],\n" });

    s.push_str("  \"unexpected\": [],\n");
    s.push_str(&format!("  \"note\": \"{}\"\n", json_escape(TRUST_NOTE)));
    s.push_str("}");
    s
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

struct Opts {
    artifact: Option<String>,
    vendor: Option<String>,
    dir: Option<String>,
    json: bool,
}

fn parse_args(argv: &[String]) -> Result<Option<Opts>, VhError> {
    let mut opts = Opts {
        artifact: None,
        vendor: None,
        dir: None,
        json: false,
    };
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        match arg.as_str() {
            "--vendor" => {
                let v = argv
                    .get(i + 1)
                    .ok_or_else(|| VhError::Usage("--vendor requires a value".into()))?;
                opts.vendor = Some(v.clone());
                i += 2;
            }
            "--dir" => {
                let v = argv
                    .get(i + 1)
                    .ok_or_else(|| VhError::Usage("--dir requires a value".into()))?;
                opts.dir = Some(v.clone());
                i += 2;
            }
            "--json" => {
                opts.json = true;
                i += 1;
            }
            "-h" | "--help" => {
                println!("{}", USAGE);
                return Ok(None);
            }
            other if other.starts_with("--") => {
                return Err(VhError::Usage(format!("unknown flag: {}", other)));
            }
            _ => {
                if opts.artifact.is_some() {
                    return Err(VhError::Usage("verify-vh verifies a single <artifact>".into()));
                }
                opts.artifact = Some(arg.clone());
                i += 1;
            }
        }
    }
    Ok(Some(opts))
}

fn run(argv: &[String]) -> u8 {
    let opts = match parse_args(argv) {
        Ok(Some(o)) => o,
        Ok(None) => return EXIT_OK, // help was printed
        Err(VhError::Usage(m)) => {
            eprintln!("error: {}", m);
            return EXIT_USAGE;
        }
        Err(VhError::Io(m)) => {
            eprintln!("error: {}", m);
            return EXIT_IO;
        }
    };

    match verify_artifact(&opts) {
        Ok((result, code)) => {
            if opts.json {
                println!("{}", render_json(&result));
            } else {
                println!("{}", render_human(&result));
            }
            code
        }
        Err(VhError::Usage(m)) => {
            eprintln!("error: {}", m);
            EXIT_USAGE
        }
        Err(VhError::Io(m)) => {
            eprintln!("error: {}", m);
            EXIT_IO
        }
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    ExitCode::from(run(&argv))
}

// ---------------------------------------------------------------------------
// Tests: keccak canonical vectors + a couple of self-checks.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_empty() {
        assert_eq!(
            keccak_hex(b""),
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }

    #[test]
    fn keccak_abc() {
        assert_eq!(
            keccak_hex(b"abc"),
            "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        );
    }
}
