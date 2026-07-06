// Command verify-vh is a third, independent verifyhash evidence-seal verifier,
// written in pure Go with no external modules: keccak256 and secp256k1 signer
// recovery are both implemented in-tree over the standard library.
//
// Usage:
//
//	verify-vh <packet> --vendor 0x.. [--dir <files>] [--json]
//
// Exit codes: 0 ACCEPT, 3 REJECT, 2 usage, 1 IO.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const usage = "usage: verify-vh <artifact> [--vendor <0xaddr>] [--dir <d>] [--json]"

func parseArgs(argv []string) (options, error) {
	opts := options{}
	haveArtifact := false

	need := func(flag string, i int) (string, error) {
		if i+1 >= len(argv) {
			return "", usageErrorf("%s requires a value", flag)
		}
		return argv[i+1], nil
	}

	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--vendor":
			v, err := need("--vendor", i)
			if err != nil {
				return opts, err
			}
			opts.vendor = &v
			i++
		case arg == "--dir":
			v, err := need("--dir", i)
			if err != nil {
				return opts, err
			}
			opts.dir = &v
			i++
		case arg == "--json":
			opts.jsonOut = true
		case arg == "-h" || arg == "--help":
			fmt.Println(usage)
			os.Exit(exitOK)
		case strings.HasPrefix(arg, "--"):
			return opts, usageErrorf("unknown flag: %s", arg)
		default:
			if haveArtifact {
				return opts, usageErrorf("verify-vh verifies a single <artifact>")
			}
			opts.artifact = arg
			haveArtifact = true
		}
	}
	return opts, nil
}

func renderHuman(r *result) string {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }

	w("%s", trustNote)
	w("")
	w("# verify-vh — %s", r.Artifact)
	w("kind:            %v", r.Kind)
	if !eq(r.PayloadKind, r.Kind) {
		w("embedded kind:   %v", r.PayloadKind)
	}
	w("signed:          %s", yesNo(r.Signed, "yes", "no"))
	if r.Signed {
		if r.RecoveredSigner != nil {
			w("recovered signer: %s", *r.RecoveredSigner)
		} else {
			w("recovered signer: (unrecoverable)")
		}
		w("claimed signer:  %s", deref(r.ClaimedSigner))
		if r.PinnedVendor != nil {
			w("pinned --vendor: %s", *r.PinnedVendor)
			w("signer matches vendor: %s", yesNoPtr(r.SignerMatchesVendor))
		} else {
			w("(no --vendor pin: the recovered signer above is reported, not pinned)")
		}
	} else if r.RecoveredSigner == nil && r.PinnedVendor != nil {
		w("note: --vendor was supplied but this artifact is UNSIGNED (no signer to pin)")
	}
	if r.SealedRoot != nil {
		w("sealed root:     %s", *r.SealedRoot)
	}
	if r.RecomputedRoot != nil {
		w("recomputed root: %s", *r.RecomputedRoot)
	}
	if r.RootMatches != nil {
		w("root matches:    %s", yesNo(*r.RootMatches, "yes", "NO"))
	}
	c := r.Counts
	w("files: %d matched, %d changed, %d missing, %d rejected, %d unexpected",
		c.Matched, c.Changed, c.Missing, c.Escaped, c.Unexpected)
	w("")

	if r.Accepted {
		w("OK — the artifact verifies.")
		return b.String()
	}

	w("REJECTED (%s):", r.Reason)
	for _, ch := range r.Changed {
		w("  CHANGED    %s: sealed %s != on-disk %s", ch.RelPath, ch.ExpectedContentHash, ch.ActualContentHash)
	}
	for _, m := range r.Missing {
		w("  MISSING    %s: referenced but not found on disk", m.RelPath)
	}
	for _, x := range r.Escaped {
		w("  REJECTED   %s: path escapes the artifact directory (refused to read; no hash computed)", x.RelPath)
	}
	for _, u := range r.Unexpected {
		w("  UNEXPECTED %s: on disk but not referenced", u.RelPath)
	}
	switch r.Reason {
	case "bad_signature":
		w("  bad_signature: the signature does not recover to the claimed signer (tampered or forged).")
	case "wrong_issuer":
		w("  wrong_issuer: recovered %s but you pinned --vendor %s.", deref(r.RecoveredSigner), deref(r.PinnedVendor))
	case "unsigned_cannot_pin_vendor":
		w("  --vendor was pinned but the artifact carries no signature to recover a signer from.")
	case "root_mismatch":
		w("  root_mismatch: the recomputed root does not equal the sealed root.")
	case "path_escape":
		w("  path_escape: the artifact references a file OUTSIDE its own directory (absolute path, `..` traversal, or an out-of-tree symlink). A genuine artifact never does this; refused to read it.")
	}
	return b.String()
}

func eq(a, b any) bool { return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b) }

func yesNo(cond bool, yes, no string) string {
	if cond {
		return yes
	}
	return no
}

func yesNoPtr(b *bool) string {
	if b != nil && *b {
		return "yes"
	}
	return "NO"
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func run(argv []string) int {
	opts, err := parseArgs(argv)
	if err == nil {
		var res *result
		var code int
		res, code, err = verifyArtifact(opts)
		if err == nil {
			if opts.jsonOut {
				out, _ := json.MarshalIndent(res, "", "  ")
				fmt.Println(string(out))
			} else {
				fmt.Print(renderHuman(res))
			}
			return code
		}
	}

	switch err.(type) {
	case *usageError:
		fmt.Fprintf(os.Stderr, "error: %s\n", err)
		return exitUsage
	case *ioError:
		fmt.Fprintf(os.Stderr, "error: %s\n", err)
		return exitIO
	default:
		fmt.Fprintf(os.Stderr, "error: %s\n", err)
		return exitIO
	}
}

func main() {
	os.Exit(run(os.Args[1:]))
}
