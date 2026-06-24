"use strict";

// TrustLedger — `vh trust serve` tests (T-27.3).
//
// `vh trust serve [--port <n>]` launches the LOCAL web front-door over the engine
// so a broker can open a browser, drop three files, and watch the balances tie out
// WITHOUT a terminal. These tests prove the CLI wiring:
//   * runServe binds an http.Server (on an EPHEMERAL port for the test), prints the
//     URL + the in-memory/HUMAN-deploy posture, GET / returns the upload page, then
//     the test CLOSES it cleanly.
//   * a bad --port is a USAGE error (exit 2) and binds NOTHING.
//   * parseServeArgs rejects unknown flags / stray positionals (parser parity).
//   * the serve path writes NOTHING to the working tree (the server is in-memory).

const { expect } = require("chai");
const fs = require("fs");
const http = require("http");

const trust = require("../trustledger/cli");
const { EXIT } = trust;

// Minimal GET over loopback. Resolves to { status, type, text }.
function get(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: pathName },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            type: res.headers["content-type"],
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Collect a writer's output into an array of strings.
function capture() {
  const out = [];
  return { out, write: (s) => out.push(s) };
}

describe("vh trust serve: the local web front-door command", function () {
  describe("argument parsing", function () {
    it("defaults: no flags => default port + host", function () {
      const opts = trust.parseServeArgs([]);
      expect(opts.port).to.equal(undefined);
      expect(opts.host).to.equal(undefined);
      expect(trust.SERVE_DEFAULT_PORT).to.equal(4173);
      expect(trust.SERVE_DEFAULT_HOST).to.equal("127.0.0.1");
    });

    it("--port <n> parses to a number", function () {
      expect(trust.parseServeArgs(["--port", "8080"]).port).to.equal(8080);
      expect(trust.parseServeArgs(["--port", "0"]).port).to.equal(0); // ephemeral
    });

    it("--host <h> is captured", function () {
      expect(trust.parseServeArgs(["--host", "0.0.0.0"]).host).to.equal("0.0.0.0");
    });

    it("a non-numeric --port is a usage error", function () {
      expect(() => trust.parseServeArgs(["--port", "abc"])).to.throw(/--port/);
    });

    it("a --port above 65535 is a usage error", function () {
      expect(() => trust.parseServeArgs(["--port", "70000"])).to.throw(/0\.\.65535/);
    });

    it("an unknown flag is a usage error", function () {
      expect(() => trust.parseServeArgs(["--nope"])).to.throw(/unknown option/);
    });

    it("a stray positional is a usage error (serve takes no positionals)", function () {
      expect(() => trust.parseServeArgs(["extra"])).to.throw(/no positionals/);
    });
  });

  describe("cmdServe early-exit on a bad flag", function () {
    it("a bad --port returns EXIT.USAGE and binds nothing", async function () {
      const err = capture();
      const code = await trust.cmdServe(["--port", "-5"], {
        writeErr: err.write,
        write: () => {},
      });
      expect(code).to.equal(EXIT.USAGE);
      expect(err.out.join("")).to.match(/--port/);
    });
  });

  describe("runServe binds, serves the page, and closes cleanly", function () {
    let started;

    afterEach(function (done) {
      // Always close any server a test started so no socket leaks across tests.
      if (started && started.server && started.server.listening) {
        started.server.close(() => {
          started = null;
          done();
        });
      } else {
        started = null;
        done();
      }
    });

    it("--port 0 binds an ephemeral port; GET / returns the upload page; prints the posture", async function () {
      const cwdBefore = fs.readdirSync(process.cwd()).sort();

      const o = capture();
      started = await trust.runServe(
        { port: 0, host: "127.0.0.1" },
        { write: o.write, writeErr: () => {}, today: () => "2026-06-24" }
      );

      expect(started.code).to.equal(EXIT.PASS);
      expect(started.server.listening).to.equal(true);

      const port = started.server.address().port;
      expect(port).to.be.a("number").and.to.be.greaterThan(0);

      // The printed banner names the real URL + the privacy/deploy posture.
      const printed = o.out.join("");
      expect(printed).to.contain(`http://127.0.0.1:${port}/`);
      expect(printed).to.match(/in memory/i);
      expect(printed.toLowerCase()).to.contain("nginx");
      expect(printed.toLowerCase()).to.contain("never auto-deployed");
      expect(started.url).to.equal(`http://127.0.0.1:${port}/`);

      // GET / returns the upload page (the same door server.js serves).
      const res = await get(port, "/");
      expect(res.status).to.equal(200);
      expect(res.type).to.match(/text\/html/);
      expect(res.text).to.match(/^<!doctype html>/i);
      expect(res.text).to.contain("TrustLedger");
      expect(res.text).to.contain("/api/reconcile");
      expect(res.text.toLowerCase()).to.contain("disclaimer");

      // The serve path wrote NOTHING to the working tree.
      expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
    });

    it("runServe with no explicit host still binds and serves the page", async function () {
      // Defaults applied inside runServe (host => 127.0.0.1). cmdServe's SUCCESS
      // branch deliberately never resolves (it holds the process open on the open
      // socket, like any server), so tests exercise the binding via runServe — the
      // unit cmdServe calls — and close the handle it returns.
      started = await trust.runServe(
        { port: 0 },
        { write: () => {}, writeErr: () => {} }
      );
      const port = started.server.address().port;
      const res = await get(port, "/");
      expect(res.status).to.equal(200);
    });
  });

  describe("a bind failure is EXIT.IO, never a collapsed PASS(0)", function () {
    let blocker;

    afterEach(function (done) {
      // Free the port we deliberately occupied, whether the test passed or failed.
      if (blocker && blocker.listening) {
        blocker.close(() => {
          blocker = null;
          done();
        });
      } else {
        blocker = null;
        done();
      }
    });

    it("cmdServe on an already-bound port resolves EXIT.IO and prints the error", function (done) {
      // Occupy an ephemeral port, then point serve at the SAME port: the second
      // bind fails with EADDRINUSE. The 'error' handler must resolve EXIT.IO so a
      // supervisor running `vh trust serve || alert` sees a non-zero exit instead
      // of Node quietly exiting 0 (the exit-class collapse this test guards).
      blocker = http.createServer((_req, res) => res.end("busy"));
      blocker.listen(0, "127.0.0.1", async () => {
        const port = blocker.address().port;
        const err = capture();
        const code = await trust.cmdServe(["--port", String(port), "--host", "127.0.0.1"], {
          writeErr: err.write,
          write: () => {},
        });
        try {
          expect(code).to.equal(EXIT.IO);
          expect(code).to.not.equal(EXIT.PASS);
          expect(err.out.join("")).to.match(/cannot start TrustLedger web door/i);
          done();
        } catch (e) {
          done(e);
        }
      });
    });

    it("runServe on an already-bound port resolves { code: EXIT.IO } (no hang)", function (done) {
      blocker = http.createServer((_req, res) => res.end("busy"));
      blocker.listen(0, "127.0.0.1", async () => {
        const port = blocker.address().port;
        const err = capture();
        const res = await trust.runServe(
          { port, host: "127.0.0.1" },
          { write: () => {}, writeErr: err.write }
        );
        try {
          expect(res.code).to.equal(EXIT.IO);
          expect(res.url).to.equal(null);
          expect(res.error).to.be.an("error");
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it("the trust help and unknown-subcommand error list `serve`", function () {
    expect(trust.trustHelp()).to.match(/serve/);
    const err = capture();
    const code = trust.cmdTrust(["bogus"], { write: () => {}, writeErr: err.write });
    expect(code).to.equal(EXIT.USAGE);
    expect(err.out.join("")).to.match(/serve/);
  });
});
