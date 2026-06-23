"use strict";

// Pure helpers over the `git` binary for the verifyhash CLI.
//
// WHY THIS EXISTS. `vh hash <dir>` walks the filesystem and hashes every regular file it finds,
// including untracked junk (`node_modules/`, `.env`, build artifacts, editor scratch files). For a
// real repository that makes the directory root depend on whatever happens to be sitting in the work
// tree, so two clones of the same commit can produce different roots. `vh hash <path> --git` instead
// hashes EXACTLY the set of files git tracks at a given commit — a reproducible, content-addressed
// snapshot that ignores untracked noise. These helpers expose that set as pure functions over `git`.
//
// SECURITY / INJECTION. Every git invocation runs via child_process.execFileSync with an explicit
// argv ARRAY and `cwd` set to the caller's directory. We NEVER build a shell command string from
// user input, so a ref or path containing shell metacharacters (`;`, `$(...)`, spaces, quotes) can
// never be interpreted by a shell — the value is passed as a single literal argv element. `shell` is
// left at its default (false). All git output that can contain arbitrary path bytes is read with
// `-z` (NUL-delimited) so paths with newlines, quotes, or other special characters are handled
// deterministically rather than going through git's default C-quoting of "unusual" path names.

const { execFileSync } = require("child_process");

// A hard cap on git's stdout so a pathological repo can't exhaust memory; ls-tree of a normal repo is
// far under this. Buffer overflow throws (ENOBUFS), which surfaces as a clear error to the caller.
const MAX_GIT_OUTPUT = 64 * 1024 * 1024; // 64 MiB

/**
 * Run `git <args...>` in `cwd` and return stdout. Pure-ish: it shells out but never through a shell
 * string — `args` is an argv array passed verbatim, so user-supplied refs/paths cannot inject.
 *
 * @param {string} cwd directory to run git in (the work tree / a path inside the repo)
 * @param {string[]} args git arguments as a literal argv array (NO shell string)
 * @param {{ encoding?: "utf8"|"buffer" }} [opts]
 * @returns {string|Buffer} stdout (utf8 string by default; Buffer if encoding:"buffer")
 */
function runGit(cwd, args, opts = {}) {
  const encoding = opts.encoding === "buffer" ? "buffer" : "utf8";
  try {
    return execFileSync("git", args, {
      cwd,
      encoding,
      maxBuffer: MAX_GIT_OUTPUT,
      // shell defaults to false: args are NOT interpreted by a shell. Do not set it.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // execFileSync attaches stderr on failure; surface it (trimmed) so callers can wrap it.
    const stderr = e.stderr
      ? Buffer.isBuffer(e.stderr)
        ? e.stderr.toString("utf8")
        : String(e.stderr)
      : "";
    const err = new Error(stderr.trim() || e.message);
    err.gitStderr = stderr;
    err.gitCode = typeof e.status === "number" ? e.status : undefined;
    throw err;
  }
}

/**
 * Resolve the top-level directory of the git work tree containing `dir`.
 *
 * Errors clearly (a single, actionable message) if `dir` is not inside a git work tree — this is the
 * guard that lets `vh hash --git` REFUSE to run on a non-git directory rather than silently falling
 * back to the filesystem walk.
 *
 * @param {string} dir a directory (or a path inside the repo)
 * @returns {string} absolute path to the repository top-level
 */
function repoRoot(dir) {
  let out;
  try {
    out = runGit(dir, ["rev-parse", "--show-toplevel"]);
  } catch (e) {
    throw new Error(
      `not a git repository (or any parent up to the mount point): ${dir}\n` +
        `  (git said: ${firstLine(e.message)})`
    );
  }
  const root = out.trim();
  if (!root) {
    throw new Error(`not a git work tree: ${dir}`);
  }
  return root;
}

/**
 * Resolve a ref / `HEAD` / short oid to a FULL 40-hex commit object id, erroring on an unknown ref.
 *
 * Uses `git rev-parse --verify --end-of-options <ref>^{commit}`: the `^{commit}` peel forces the ref
 * to name (or dereference to) a commit, and `--verify` makes git exit non-zero — rather than echoing
 * the input — when the ref does not exist or does not resolve to a commit. `--end-of-options` stops a
 * ref that begins with `-` from being mis-parsed as a flag. The result is always a 40-char lowercase
 * hex oid (verified before returning).
 *
 * @param {string} dir a directory inside the repo
 * @param {string} [ref] the ref to resolve (default "HEAD")
 * @returns {string} a full 40-hex commit oid (lowercase)
 */
function resolveCommit(dir, ref) {
  const r = ref === undefined || ref === null || ref === "" ? "HEAD" : String(ref);
  let out;
  try {
    out = runGit(dir, ["rev-parse", "--verify", "--end-of-options", `${r}^{commit}`]);
  } catch (e) {
    throw new Error(
      `unknown git ref: ${r}\n  (git could not resolve it to a commit: ${firstLine(e.message)})`
    );
  }
  const oid = out.trim();
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    // rev-parse --verify of a real commit always yields a 40-hex oid; anything else is anomalous.
    throw new Error(`git did not resolve ref '${r}' to a 40-hex commit oid (got: ${oid})`);
  }
  return oid;
}

/**
 * List the repo-relative POSIX paths that git tracks at `ref` (default HEAD), sorted ascending.
 *
 * Uses `git ls-tree -r -z --name-only --full-tree <oid>`:
 *   - `-r` recurses into subtrees so the list is the full flat set of tracked blob paths,
 *   - `--name-only` returns just the paths (no mode/type/oid columns),
 *   - `-z` makes the output NUL-delimited so paths containing newlines, quotes, spaces, or other
 *     special characters are emitted VERBATIM (git's default would C-quote such "unusual" paths,
 *     which would corrupt the path we bind into each Merkle leaf),
 *   - `--full-tree` makes the listing relative to the repo root regardless of `cwd`,
 *   - resolving `ref` to a concrete oid first means the listing is taken from the COMMIT's tree, not
 *     from the index/work tree, so it is independent of staged/unstaged changes.
 * git already emits ls-tree paths as repo-root-relative forward-slash paths, but we sort them
 * ourselves (deterministic, locale-independent) so the result order does not depend on git's.
 *
 * Submodules (commit/gitlink entries) are NOT regular files and have no blob content; they are
 * excluded so the caller only ever tries to read real tracked file bytes.
 *
 * @param {string} dir a directory inside the repo
 * @param {string} [ref] the ref/commit to list (default "HEAD")
 * @returns {string[]} sorted repo-relative POSIX paths of tracked files at that commit
 */
function listTrackedFiles(dir, ref) {
  const oid = resolveCommit(dir, ref);
  // Read as a Buffer so NUL-delimited splitting is byte-exact; git paths are UTF-8 by default.
  const buf = runGit(dir, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", oid], {
    encoding: "buffer",
  });
  const text = buf.toString("utf8");
  // Split on NUL; the last element is an empty trailing chunk (git terminates each path with \0).
  const paths = text.split("\0").filter((p) => p.length > 0);
  // Deterministic, locale-independent sort by code unit (matches the CLI's leaf-sort independence:
  // the tree is sorted by leaf value anyway, but a stable path order keeps output reproducible).
  paths.sort();
  return paths;
}

/** First line of a possibly-multiline string, trimmed. */
function firstLine(s) {
  const str = String(s || "");
  const nl = str.indexOf("\n");
  return (nl === -1 ? str : str.slice(0, nl)).trim();
}

module.exports = {
  runGit,
  repoRoot,
  resolveCommit,
  listTrackedFiles,
};
