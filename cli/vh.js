#!/usr/bin/env node
"use strict";

// verifyhash CLI entrypoint.
//
// Implemented commands:
//   vh hash <path>   Print the keccak256 of a file, or the sorted-leaf Merkle root of a
//                    directory (matching ContributionRegistry.verifyLeaf).
//
// Other commands (anchor, verify, prove) are defined by later backlog tasks (T-1.2+).

const { hashPath } = require("./hash");

function usage() {
  return [
    "vh — verifyhash CLI",
    "",
    "Usage:",
    "  vh hash <path>    keccak256 of a file, or sorted-leaf Merkle root of a directory",
    "",
  ].join("\n");
}

function cmdHash(argv) {
  const target = argv[0];
  if (!target) {
    process.stderr.write("error: `vh hash` requires a <path>\n\n" + usage());
    return 2;
  }
  let result;
  try {
    result = hashPath(target);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  if (result.kind === "file") {
    process.stdout.write(result.root + "\n");
  } else {
    // Directory: print the root, then each file's leaf for transparency.
    process.stdout.write(result.root + "\n");
    for (const { path: p, leaf } of result.leaves) {
      process.stdout.write(`${leaf}  ${p}\n`);
    }
  }
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hash":
      return cmdHash(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(usage());
      return 0;
    default:
      process.stderr.write(`error: unknown command: ${cmd}\n\n` + usage());
      return 2;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, cmdHash, usage };
