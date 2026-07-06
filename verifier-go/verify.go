package main

// The verify engine: parse the artifact JSON, classify each sealed file against
// a confined disk source, re-derive the root, recover the EIP-191 signer, and
// assemble a deterministic ACCEPT/REJECT verdict per SPEC §5.

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Exit codes (the top-level return contract).
const (
	exitOK       = 0
	exitIO       = 1
	exitUsage    = 2
	exitRejected = 3
)

const (
	kindEvidenceSeal       = "vh.evidence-seal"
	kindEvidenceSealSigned = "vh.evidence-seal-signed"
)

const trustNote = "verify-vh is an INDEPENDENT, read-only, OFFLINE verifier. It RE-DERIVES the keccak root from the " +
	"bytes you hold and recovers the signer with no producer stack. It proves TAMPER-EVIDENCE + WHO " +
	"vouched — NOT a trusted timestamp and NOT a legal opinion."

var (
	hex32Re   = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
	addressRe = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	sigRe     = regexp.MustCompile(`^0x[0-9a-fA-F]{130}$`)
)

// usageError → exit 2 (caller/flag problems); ioError → exit 1 (structural/parse).
type usageError struct{ msg string }
type ioError struct{ msg string }

func (e *usageError) Error() string { return e.msg }
func (e *ioError) Error() string    { return e.msg }

func usageErrorf(format string, a ...any) error { return &usageError{fmt.Sprintf(format, a...)} }
func ioErrorf(format string, a ...any) error    { return &ioError{fmt.Sprintf(format, a...)} }

// ---- result shapes (JSON keys/order match the sibling verifiers) ------------

type changedFile struct {
	RelPath             string `json:"relPath"`
	ExpectedContentHash string `json:"expectedContentHash"`
	ActualContentHash   string `json:"actualContentHash"`
}

type namedFile struct {
	RelPath     string `json:"relPath"`
	ContentHash string `json:"contentHash,omitempty"`
}

type counts struct {
	Matched    int `json:"matched"`
	Changed    int `json:"changed"`
	Missing    int `json:"missing"`
	Escaped    int `json:"escaped"`
	Unexpected int `json:"unexpected"`
}

type result struct {
	Artifact            string        `json:"artifact"`
	Kind                any           `json:"kind"`
	PayloadKind         any           `json:"payloadKind"`
	Signed              bool          `json:"signed"`
	Verdict             string        `json:"verdict"`
	Reason              string        `json:"reason"`
	Accepted            bool          `json:"accepted"`
	RecoveredSigner     *string       `json:"recoveredSigner"`
	ClaimedSigner       *string       `json:"claimedSigner"`
	PinnedVendor        *string       `json:"pinnedVendor"`
	SignatureOk         *bool         `json:"signatureOk"`
	SignerMatchesVendor *bool         `json:"signerMatchesVendor"`
	SealedRoot          *string       `json:"sealedRoot"`
	RecomputedRoot      *string       `json:"recomputedRoot"`
	RootMatches         *bool         `json:"rootMatches"`
	Counts              counts        `json:"counts"`
	Matched             []namedFile   `json:"matched"`
	Changed             []changedFile `json:"changed"`
	Missing             []namedFile   `json:"missing"`
	Escaped             []namedFile   `json:"escaped"`
	Unexpected          []namedFile   `json:"unexpected"`
	ExactDir            bool          `json:"exactDir,omitempty"`
	Note                string        `json:"note"`
}

// ---- confined disk file source ---------------------------------------------

type readStatus int

const (
	statusOK readStatus = iota
	statusMissing
	statusEscaped
)

// diskSource resolves sealed relPaths under baseDir and refuses to read
// anything that escapes it (absolute paths, ".." components, out-of-tree
// symlinks), matching the JS/Python confinement.
type diskSource struct {
	baseDir  string
	baseReal string
}

func newDiskSource(baseDir string) *diskSource {
	real, err := filepath.EvalSymlinks(baseDir)
	if err != nil {
		real, _ = filepath.Abs(baseDir)
	}
	return &diskSource{baseDir: baseDir, baseReal: real}
}

func (d *diskSource) escapes(absPath string) bool {
	rel, err := filepath.Rel(d.baseReal, absPath)
	if err != nil {
		return true
	}
	return rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel)
}

// read returns the file bytes, or a non-OK status for a missing/hostile path.
func (d *diskSource) read(rel string) (readStatus, []byte) {
	// (1) string-level confinement before any filesystem access.
	if rel == "" || filepath.IsAbs(rel) || hasDotDotComponent(rel) {
		return statusEscaped, nil
	}
	absPath, err := filepath.Abs(filepath.Join(d.baseDir, rel))
	if err != nil {
		return statusEscaped, nil
	}
	// (2) resolved-path confinement.
	if d.escapes(absPath) {
		return statusEscaped, nil
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return statusMissing, nil
	}
	// (3) post-open symlink confinement.
	if real, err := filepath.EvalSymlinks(absPath); err == nil && d.escapes(real) {
		return statusEscaped, nil
	}
	return statusOK, data
}

// hasDotDotComponent reports whether any '/'- or '\\'-separated component is "..".
func hasDotDotComponent(rel string) bool {
	for _, part := range strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return true
		}
	}
	return false
}

// ---- seal parsing + classification -----------------------------------------

type sealEntry struct {
	relPath     string
	contentHash string
}

// fileClassification is the outcome of matching sealed entries against disk.
type fileClassification struct {
	matched []namedFile
	changed []changedFile
	missing []namedFile
	escaped []namedFile
	flat    []presentFile
}

func classifyFiles(entries []sealEntry, src *diskSource) fileClassification {
	var fc fileClassification
	for _, e := range entries {
		status, data := src.read(e.relPath)
		switch status {
		case statusEscaped:
			fc.escaped = append(fc.escaped, namedFile{RelPath: e.relPath})
			continue
		case statusMissing:
			fc.missing = append(fc.missing, namedFile{RelPath: e.relPath})
			continue
		}
		actual := contentDigestHex(data)
		fc.flat = append(fc.flat, presentFile{relPath: e.relPath, contentHash: actual})
		if strings.EqualFold(actual, e.contentHash) {
			fc.matched = append(fc.matched, namedFile{RelPath: e.relPath, ContentHash: actual})
		} else {
			fc.changed = append(fc.changed, changedFile{
				RelPath:             e.relPath,
				ExpectedContentHash: e.contentHash,
				ActualContentHash:   actual,
			})
		}
	}
	return fc
}

// evidenceResult holds the file-side outcome for verdict assembly.
type evidenceResult struct {
	fc             fileClassification
	sealedRoot     string
	recomputedRoot *string
	rootMatches    bool
	filesOk        bool
}

// verifyEvidenceSeal validates the bare-seal payload structure and re-derives
// the root from disk.
func verifyEvidenceSeal(payload map[string]any, src *diskSource) (*evidenceResult, error) {
	rawFiles, ok := payload["files"].([]any)
	if !ok || len(rawFiles) == 0 {
		return nil, ioErrorf("evidence seal `files` must be a non-empty array")
	}
	entries := make([]sealEntry, 0, len(rawFiles))
	for _, rf := range rawFiles {
		obj, ok := rf.(map[string]any)
		if !ok {
			return nil, ioErrorf("evidence seal `files` entry must be an object")
		}
		rel, _ := obj["relPath"].(string)
		ch, _ := obj["contentHash"].(string)
		entries = append(entries, sealEntry{relPath: rel, contentHash: ch})
	}

	root, ok := payload["root"].(string)
	if !ok || !hex32Re.MatchString(root) {
		return nil, ioErrorf("evidence seal `root` must be a 0x-prefixed 32-byte hex string")
	}

	fc := classifyFiles(entries, src)

	var recomputed *string
	if len(fc.flat) > 0 {
		if r, err := rootFromFlat(fc.flat); err == nil {
			recomputed = &r
		}
	}

	rootMatches := len(fc.missing) == 0 && len(fc.changed) == 0 && len(fc.escaped) == 0 &&
		recomputed != nil && strings.EqualFold(*recomputed, root)
	filesOk := len(fc.changed) == 0 && len(fc.missing) == 0 && len(fc.escaped) == 0 && rootMatches

	return &evidenceResult{
		fc:             fc,
		sealedRoot:     root,
		recomputedRoot: recomputed,
		rootMatches:    rootMatches,
		filesOk:        filesOk,
	}, nil
}

// ---- signed-container decoding ---------------------------------------------

type signedDecoded struct {
	embedded      map[string]any
	embeddedKind  any
	message       []byte // the attestation string verbatim, as UTF-8 bytes
	claimedSigner string
	signatureHex  string
}

func decodeSigned(container map[string]any) (*signedDecoded, error) {
	sig, ok := container["signature"].(map[string]any)
	if !ok {
		return nil, ioErrorf("signed artifact is missing a { scheme, signer, signature } signature block")
	}
	if scheme, _ := sig["scheme"].(string); scheme != "eip191-personal-sign" {
		return nil, ioErrorf("unsupported signature scheme: %q (this verifier understands eip191-personal-sign)", sig["scheme"])
	}
	attestation, ok := container["attestation"].(string)
	if !ok {
		return nil, ioErrorf("signed artifact must embed the canonical UNSIGNED bytes as a string `attestation`")
	}
	signature, ok := sig["signature"].(string)
	if !ok || !sigRe.MatchString(signature) {
		return nil, ioErrorf("signed artifact signature must be a 65-byte (r||s||v) 0x-hex string")
	}
	signer, ok := sig["signer"].(string)
	if !ok || !addressRe.MatchString(signer) {
		return nil, ioErrorf("signed artifact signer must be a 0x-prefixed 20-byte hex address")
	}

	var embedded map[string]any
	if err := json.Unmarshal([]byte(attestation), &embedded); err != nil {
		return nil, ioErrorf("embedded attestation is not valid JSON: %v", err)
	}

	return &signedDecoded{
		embedded:      embedded,
		embeddedKind:  embedded["kind"],
		message:       []byte(attestation),
		claimedSigner: strings.ToLower(signer),
		signatureHex:  signature,
	}, nil
}

// tryRecover recovers the lowercase signer, or nil on any failure.
func tryRecover(message []byte, signatureHex string) *string {
	raw, err := hex.DecodeString(strings.TrimPrefix(signatureHex, "0x"))
	if err != nil {
		return nil
	}
	addr, ok := recoverPersonalSign(message, raw)
	if !ok {
		return nil
	}
	return &addr
}

// ---- verdict assembly ------------------------------------------------------

func normalizeAddress(addr, label string) (string, error) {
	if !addressRe.MatchString(addr) {
		return "", usageErrorf("%s must be a 0x-prefixed 20-byte hex address, got: %s", label, addr)
	}
	return strings.ToLower(addr), nil
}

// verifyParsed runs the decision tree over an already-parsed artifact object.
func verifyParsed(artifactName string, obj map[string]any, vendor *string, baseDir string) (*result, int, error) {
	kind := obj["kind"]

	var pinned *string
	if vendor != nil {
		p, err := normalizeAddress(*vendor, "--vendor")
		if err != nil {
			return nil, 0, err
		}
		pinned = &p
	}

	signed := false
	var recoveredSigner *string
	var claimedSigner *string
	var signatureOk *bool
	payload := obj
	payloadKind := kind

	switch kind {
	case kindEvidenceSealSigned:
		signed = true
		dec, err := decodeSigned(obj)
		if err != nil {
			return nil, 0, err
		}
		payload = dec.embedded
		payloadKind = dec.embeddedKind
		cs := dec.claimedSigner
		claimedSigner = &cs
		recoveredSigner = tryRecover(dec.message, dec.signatureHex)
		ok := recoveredSigner != nil && *recoveredSigner == cs
		signatureOk = &ok
	case kindEvidenceSeal:
		// bare seal, handled below
	default:
		return nil, 0, usageErrorf("unrecognized artifact kind: %q (verify-vh understands evidence seals)", kind)
	}

	if payloadKind != kindEvidenceSeal {
		return nil, 0, usageErrorf("unrecognized embedded artifact kind: %q", payloadKind)
	}

	fr, err := verifyEvidenceSeal(payload, newDiskSource(baseDir))
	if err != nil {
		return nil, 0, err
	}

	reason := "OK"
	accepted := true
	if !fr.filesOk {
		accepted = false
		switch {
		case len(fr.fc.escaped) > 0:
			reason = "path_escape"
		case len(fr.fc.changed) > 0:
			reason = "CHANGED"
		case len(fr.fc.missing) > 0:
			reason = "MISSING"
		default:
			reason = "root_mismatch"
		}
	}

	var signerMatchesVendor *bool
	if signed {
		if !*signatureOk {
			accepted = false
			reason = "bad_signature"
		} else if pinned != nil {
			matches := recoveredSigner != nil && *recoveredSigner == *pinned
			signerMatchesVendor = &matches
			if !matches {
				accepted = false
				if fr.filesOk || reason == "OK" {
					reason = "wrong_issuer"
				}
			}
		}
	} else if pinned != nil {
		accepted = false
		reason = "unsigned_cannot_pin_vendor"
	}

	verdict := "REJECTED"
	code := exitRejected
	if accepted {
		verdict = "OK"
		code = exitOK
	}

	sealedRoot := fr.sealedRoot
	rootMatches := fr.rootMatches
	res := &result{
		Artifact:            artifactName,
		Kind:                kind,
		PayloadKind:         payloadKind,
		Signed:              signed,
		Verdict:             verdict,
		Reason:              reason,
		Accepted:            accepted,
		RecoveredSigner:     recoveredSigner,
		ClaimedSigner:       claimedSigner,
		PinnedVendor:        pinned,
		SignatureOk:         signatureOk,
		SignerMatchesVendor: signerMatchesVendor,
		SealedRoot:          &sealedRoot,
		RecomputedRoot:      fr.recomputedRoot,
		RootMatches:         &rootMatches,
		Counts: counts{
			Matched:    len(fr.fc.matched),
			Changed:    len(fr.fc.changed),
			Missing:    len(fr.fc.missing),
			Escaped:    len(fr.fc.escaped),
			Unexpected: 0,
		},
		Matched:    orEmpty(fr.fc.matched),
		Changed:    orEmptyChanged(fr.fc.changed),
		Missing:    orEmpty(fr.fc.missing),
		Escaped:    orEmpty(fr.fc.escaped),
		Unexpected: []namedFile{},
		Note:       trustNote,
	}
	return res, code, nil
}

func orEmpty(s []namedFile) []namedFile {
	if s == nil {
		return []namedFile{}
	}
	return s
}

func orEmptyChanged(s []changedFile) []changedFile {
	if s == nil {
		return []changedFile{}
	}
	return s
}

// ---- FAIL-CLOSED --exact-dir (T-75.5 parity with the JS verifier) -----------
//
// A seal binds a NAMED FILE SET, never a directory boundary: the default verify
// checks exactly the (relPath, content) set the seal names, so an INJECTED file
// the seal never named is simply NOT COVERED — the default verdict stays ACCEPT
// (the seal's honest, by-design semantics). --exact-dir closes the boundary: it
// scans the WHOLE base directory (recursively) and REJECTS (exit 3, reason
// UNEXPECTED) any file present on disk but not named by the seal. Scan
// semantics mirror verifier/verify-vh.js:
//   - every non-directory entry counts (a symlink — including one to a
//     directory — is listed as itself and NEVER followed);
//   - the artifact file itself is exempt when it lives inside the scanned
//     directory (a seal never names its own container);
//   - an unreadable (sub)directory is an IO error (exit 1) — fail closed,
//     never a silently-partial scan;
//   - an already-REJECTED verdict keeps its dominant reason; the unexpected
//     list still rides along as extra localization.

// listDirEntriesRecursive lists every non-directory entry under baseDir as a
// sorted forward-slash relPath. os.ReadDir's DirEntry.IsDir reflects the entry
// TYPE (lstat semantics), so a symlink to a directory is listed, not followed.
func listDirEntriesRecursive(baseDir string) ([]string, error) {
	out := []string{}
	var walk func(dirAbs, relPrefix string) error
	walk = func(dirAbs, relPrefix string) error {
		entries, err := os.ReadDir(dirAbs)
		if err != nil {
			return ioErrorf("--exact-dir could not scan %s: %v", dirAbs, err)
		}
		for _, ent := range entries {
			rel := ent.Name()
			if relPrefix != "" {
				rel = relPrefix + "/" + ent.Name()
			}
			if ent.IsDir() {
				if err := walk(filepath.Join(dirAbs, ent.Name()), rel); err != nil {
					return err
				}
			} else {
				out = append(out, rel)
			}
		}
		return nil
	}
	if err := walk(baseDir, ""); err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// applyExactDir folds the whole-directory scan onto an already-computed
// verdict. Mutates res (attaches exactDir, the populated unexpected list +
// counter) and returns the possibly-downgraded exit code.
func applyExactDir(res *result, code int, baseDir, artifactPath string) (int, error) {
	// The seal's NAMED set is exactly what classification bucketed: every sealed
	// relPath landed in matched, changed, missing, or escaped.
	named := map[string]bool{}
	for _, e := range res.Matched {
		named[e.RelPath] = true
	}
	for _, e := range res.Changed {
		named[e.RelPath] = true
	}
	for _, e := range res.Missing {
		named[e.RelPath] = true
	}
	for _, e := range res.Escaped {
		named[e.RelPath] = true
	}

	rels, err := listDirEntriesRecursive(baseDir)
	if err != nil {
		return 0, err
	}
	unexpected := []namedFile{}
	for _, rel := range rels {
		if named[rel] {
			continue
		}
		// The artifact's own container file is exempt (a seal never names itself).
		abs, absErr := filepath.Abs(filepath.Join(baseDir, filepath.FromSlash(rel)))
		if absErr == nil && artifactPath != "" && abs == artifactPath {
			continue
		}
		unexpected = append(unexpected, namedFile{RelPath: rel})
	}

	res.ExactDir = true
	res.Unexpected = unexpected
	res.Counts.Unexpected = len(unexpected)
	if len(unexpected) > 0 && res.Accepted {
		res.Accepted = false
		res.Verdict = "REJECTED"
		res.Reason = "UNEXPECTED"
		return exitRejected, nil
	}
	return code, nil
}

// ---- artifact loading ------------------------------------------------------

type options struct {
	artifact string
	vendor   *string
	dir      *string
	exactDir bool
	jsonOut  bool
}

func verifyArtifact(opts options) (*result, int, error) {
	if opts.artifact == "" {
		return nil, 0, usageErrorf("verify-vh requires an <artifact>")
	}
	artifactPath, err := filepath.Abs(opts.artifact)
	if err != nil {
		return nil, 0, ioErrorf("cannot resolve artifact %s: %v", opts.artifact, err)
	}
	text, err := os.ReadFile(artifactPath)
	if err != nil {
		return nil, 0, ioErrorf("cannot read artifact %s: %v", opts.artifact, err)
	}

	var obj map[string]any
	if err := json.Unmarshal(text, &obj); err != nil {
		return nil, 0, ioErrorf("artifact %s is not valid JSON (or not a JSON object): %v", opts.artifact, err)
	}

	baseDir := filepath.Dir(artifactPath)
	if opts.dir != nil {
		if baseDir, err = filepath.Abs(*opts.dir); err != nil {
			return nil, 0, ioErrorf("cannot resolve --dir %s: %v", *opts.dir, err)
		}
	}

	res, code, err := verifyParsed(opts.artifact, obj, opts.vendor, baseDir)
	if err != nil {
		return nil, 0, err
	}
	if opts.exactDir {
		code, err = applyExactDir(res, code, baseDir, artifactPath)
		if err != nil {
			return nil, 0, err
		}
	}
	return res, code, nil
}
