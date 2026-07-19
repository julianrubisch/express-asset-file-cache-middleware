import * as chai from "chai";
import sinon from "sinon";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import crypto from "crypto";

import middleware from "../index.js";

const expect = chai.expect;
const { cacheAsset } = middleware;

// Regression tests for issue #51.
//
// The cache-miss/populate path streams a download to a `.tmp-…` file inside the
// asset's cache directory before atomically renaming it into place. The
// cache-hit path used to select the cached file with an *unfiltered*
// `fs.readdirSync(dir)[0]`, so a serve request landing while a concurrent
// download for the same key was mid-stream could pick the `.tmp-…` file. Its
// name then base64-decoded to garbage, yielding:
//   - a Content-Length string with control/invalid characters ->
//     `res.set("Content-Length", …)` throws ERR_INVALID_CHAR, and
//   - a read of a half-written file -> a truncated/garbage body.
//
// The fix (a) skips temp/dotfiles when selecting the cached entry, (b) derives
// Content-Length from the buffer itself, and (c) sanitizes the content type
// before it reaches a header.
describe("tmp-file cache-hit race (#51)", function() {
  const ASSET = crypto.randomBytes(64 * 1024); // 64 KiB

  let server;
  let baseUrl;
  let cacheDir;
  let originalEvict;
  let hits; // upstream request count per URL path

  before(function(done) {
    // Eviction's async folder scan races the per-test temp dir cleanup; it has
    // its own coverage elsewhere. Disable it for determinism (see
    // streaming.test.mjs).
    originalEvict = middleware.evictLeastRecentlyUsed;
    middleware.evictLeastRecentlyUsed = () => {};

    server = http.createServer((req, res) => {
      hits[req.url] = (hits[req.url] || 0) + 1;
      if (req.url === "/asset") {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": ASSET.length
        });
        res.end(ASSET);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  after(function(done) {
    middleware.evictLeastRecentlyUsed = originalEvict;
    server.close(done);
  });

  beforeEach(function() {
    hits = {};
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-race-test-"));
  });

  afterEach(function() {
    sinon.restore();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  // Express-ish res double whose set() mimics Node's HTTP header validation:
  // it throws ERR_INVALID_CHAR (exactly as ServerResponse.setHeader does) when
  // a string header value carries characters that are illegal in a header.
  // This is what turned the buggy cache-hit path into a hard crash.
  function makeStrictRes(locals, reqHeaders) {
    const assign = function(headers, key, value) {
      if (typeof value === "string" && /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
        const err = new TypeError(
          `Invalid character in header content ["${key}"]`
        );
        err.code = "ERR_INVALID_CHAR";
        throw err;
      }
      headers[key] = value;
    };
    return {
      locals: locals || {},
      headers: {},
      statusCode: 200,
      __req: { headers: reqHeaders || {} },
      _body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(key, value) {
        if (typeof key === "object") {
          for (const k of Object.keys(key)) assign(this.headers, k, key[k]);
        } else {
          assign(this.headers, key, value);
        }
        return this;
      },
      send(body) {
        this._body = body;
        return this;
      },
      end(body) {
        this._body = body;
        return this;
      }
    };
  }

  describe("cacheAsset selection", function() {
    it("does not serve an in-flight `.tmp-…` file as a cache hit", async function() {
      const { path: assetCachePath } = middleware.makeAssetCachePath(
        cacheDir,
        `${baseUrl}/asset`
      );
      fs.mkdirSync(assetCachePath, { recursive: true });
      // A concurrent writer, mid-download: a half-written temp file and no
      // published entry yet.
      const tmpName = `.tmp-${crypto.randomBytes(8).toString("hex")}`;
      fs.writeFileSync(
        path.join(assetCachePath, tmpName),
        ASSET.subarray(0, 1024)
      );

      const result = await cacheAsset(`${baseUrl}/asset`, { cacheDir });

      // Treated as a miss and fetched cleanly, not served from the temp file.
      expect(result.status).to.equal("cached");
      expect(result.fromCache).to.equal(false);
      expect(result.contentType).to.equal("image/png");
      // Clean numeric length string, not base64-garbage from the temp name.
      expect(result.contentLength).to.equal(String(ASSET.length));
      expect(path.basename(result.path).startsWith("."), "not a dotfile").to.equal(
        false
      );
      expect(fs.readFileSync(result.path).equals(ASSET)).to.equal(true);
    });

    it("selects the published entry, not a sibling temp file, on a cache hit", async function() {
      const { path: assetCachePath } = middleware.makeAssetCachePath(
        cacheDir,
        `${baseUrl}/asset`
      );
      fs.mkdirSync(assetCachePath, { recursive: true });
      // A real, published cache entry...
      const realName = middleware.encodeAssetCacheName("image/png", ASSET.length);
      fs.writeFileSync(path.join(assetCachePath, realName), ASSET);
      // ...next to a concurrent writer's in-flight temp file.
      const tmpName = `.tmp-${crypto.randomBytes(8).toString("hex")}`;
      fs.writeFileSync(path.join(assetCachePath, tmpName), Buffer.from("partial"));

      const result = await cacheAsset(`${baseUrl}/asset`, { cacheDir });

      expect(result.fromCache, "served from cache").to.equal(true);
      expect(path.basename(result.path)).to.equal(realName);
      expect(result.contentType).to.equal("image/png");
      expect(result.contentLength).to.equal(String(ASSET.length));
      // Pure cache hit: the upstream server was never contacted.
      expect(hits["/asset"]).to.equal(undefined);
    });

    it("treats an empty asset directory as a miss (no infinite recursion)", async function() {
      const { path: assetCachePath } = middleware.makeAssetCachePath(
        cacheDir,
        `${baseUrl}/asset`
      );
      // An empty leftover directory (e.g. a prior aborted write).
      fs.mkdirSync(assetCachePath, { recursive: true });

      const result = await cacheAsset(`${baseUrl}/asset`, { cacheDir });

      expect(result.status).to.equal("cached");
      expect(result.fromCache).to.equal(false);
      expect(fs.readFileSync(result.path).equals(ASSET)).to.equal(true);
    });
  });

  describe("sendBuffer robustness", function() {
    it("emits a valid numeric Content-Length from the buffer even when the decoded length is garbage", function() {
      const buf = Buffer.from("hello world");
      // Exactly what the buggy cache-hit path produced from a `.tmp-…` name:
      // a string with control characters that makes a real res.set() throw
      // ERR_INVALID_CHAR.
      const garbageLength = "\x00\x07\x1f-not-a-length";
      const res = makeStrictRes({
        buffer: buf,
        contentType: "text/plain",
        contentLength: garbageLength
      });

      expect(() =>
        middleware.sendBuffer(res.__req, res)
      ).to.not.throw();
      expect(res.headers["Content-Length"]).to.equal(buf.length);
      expect(res._body.equals(buf)).to.equal(true);
    });

    it("falls back to a safe content type when the decoded type has invalid header characters", function() {
      const buf = Buffer.from("payload");
      const res = makeStrictRes({
        buffer: buf,
        // CR/LF and control bytes, as a mangled base64 decode could yield.
        contentType: "image/png\r\nX-Injected: 1",
        contentLength: String(buf.length)
      });

      expect(() =>
        middleware.sendBuffer(res.__req, res)
      ).to.not.throw();
      expect(res.headers["Content-Type"]).to.equal("application/octet-stream");
      expect(res.headers["Content-Length"]).to.equal(buf.length);
      expect(res._body.equals(buf)).to.equal(true);
    });
  });

  describe("middleware end-to-end", function() {
    it("serves a clean, complete response when a concurrent download's temp file is present", async function() {
      const { path: assetCachePath } = middleware.makeAssetCachePath(
        cacheDir,
        `${baseUrl}/asset`
      );
      fs.mkdirSync(assetCachePath, { recursive: true });
      // The precache-manager race: a published entry AND a concurrent writer's
      // in-flight temp file living side by side.
      fs.writeFileSync(
        path.join(
          assetCachePath,
          `.tmp-${crypto.randomBytes(8).toString("hex")}`
        ),
        ASSET.subarray(0, 2048)
      );
      const realName = middleware.encodeAssetCacheName("image/png", ASSET.length);
      fs.writeFileSync(path.join(assetCachePath, realName), ASSET);

      const res = makeStrictRes({ fetchUrl: `${baseUrl}/asset` });
      const mw = middleware({ cacheDir });

      let nextErr;
      await mw(res.__req, res, err => {
        nextErr = err;
      });
      expect(nextErr, "middleware called next() without error").to.equal(
        undefined
      );

      // Drive the sender the way a downstream handler would.
      middleware.sendBuffer(res.__req, res);

      expect(res.statusCode).to.equal(200);
      expect(res.headers["Content-Type"]).to.equal("image/png");
      expect(res.headers["Content-Length"]).to.equal(ASSET.length);
      expect(res._body.equals(ASSET), "full, untruncated body").to.equal(true);
      // Cache hit: upstream never contacted.
      expect(hits["/asset"]).to.equal(undefined);
    });
  });

  describe("content-type header hardening", function() {
    it("preserves a content type Node considers valid (tab / latin1 obs-text)", function() {
      // Node's setHeader accepts tab (0x09) and 0x80-0xff obs-text; the
      // sanitizer must not downgrade those to application/octet-stream.
      const buf = Buffer.from("data");
      const original = "text/plain; note=café\tx=1"; // é = 0xe9, plus a tab
      const res = makeStrictRes({
        buffer: buf,
        contentType: original,
        contentLength: String(buf.length)
      });

      expect(() => middleware.sendBuffer(res.__req, res)).to.not.throw();
      expect(res.headers["Content-Type"]).to.equal(original);
    });

    it("preserves an empty content type instead of forcing octet-stream", function() {
      // An asset cached with no content type (e.g. a chunked response) must
      // still serve an empty Content-Type, exactly as before the sanitizer.
      const buf = Buffer.from("data");
      const res = makeStrictRes({
        buffer: buf,
        contentType: "",
        contentLength: String(buf.length)
      });

      middleware.sendBuffer(res.__req, res);
      expect(res.headers["Content-Type"]).to.equal("");
      expect(res.headers["Content-Length"]).to.equal(buf.length);
    });

    it("sanitizes an upstream error's content type on the middleware error path", async function() {
      // A broken/hostile upstream can return a content-type with control
      // characters on a 4xx/5xx. The middleware forwards the upstream status
      // and body; setting the raw header would throw ERR_INVALID_CHAR and turn
      // a forwarded 502 into a generic 500.
      sinon.stub(middleware, "cacheAsset").resolves({
        status: "error",
        httpStatus: 502,
        statusText: "Bad Gateway",
        contentType: "text/html\r\nX-Injected: 1",
        body: "<h1>Bad Gateway</h1>"
      });

      const res = makeStrictRes({ fetchUrl: `${baseUrl}/asset` });
      const mw = middleware({ cacheDir });

      let threw = false;
      try {
        await mw(res.__req, res, () => {});
      } catch (_) {
        threw = true;
      }

      expect(threw, "middleware must not throw").to.equal(false);
      // Forwarded, not swallowed into a 500.
      expect(res.statusCode).to.equal(502);
      expect(String(res._body)).to.contain("Bad Gateway");
      expect(res.headers["Content-Type"]).to.equal("application/octet-stream");
    });
  });

  // Follow-up concurrency hardening (issue #53).
  describe("concurrency hardening (#53)", function() {
    describe("makeDirIfNotExists (recursive, EEXIST-safe)", function() {
      it("creates missing parent directories", function() {
        const nested = path.join(cacheDir, "a", "b", "c");
        middleware.makeDirIfNotExists(nested);
        expect(fs.existsSync(nested)).to.equal(true);
      });

      it("is idempotent: repeating on an existing dir does not throw EEXIST", function() {
        const dir = path.join(cacheDir, "x", "y");
        middleware.makeDirIfNotExists(dir);
        // Old code was `if (!existsSync) mkdirSync(dir)`; a concurrent caller
        // that lost the check-then-create race hit EEXIST. Recursive mkdir is
        // idempotent, so a repeat call must be a clean no-op.
        expect(() => middleware.makeDirIfNotExists(dir)).to.not.throw();
        expect(fs.existsSync(dir)).to.equal(true);
      });
    });

    describe("ENOENT re-fetch on the read TOCTOU", function() {
      it("re-fetches when the selected cache file vanished before it is read", async function() {
        const evicted = path.join(cacheDir, "evicted-blob"); // never created
        const repopulated = path.join(cacheDir, "repopulated");
        fs.writeFileSync(repopulated, ASSET);

        const stub = sinon.stub(middleware, "cacheAsset");
        stub.onFirstCall().resolves({
          status: "cached",
          fromCache: true,
          path: evicted, // unlinked between selection and read
          contentType: "image/png",
          contentLength: String(ASSET.length)
        });
        stub.onSecondCall().resolves({
          status: "cached",
          fromCache: false,
          path: repopulated, // the retry re-populates
          contentType: "image/png",
          contentLength: String(ASSET.length)
        });

        const res = makeStrictRes({ fetchUrl: `${baseUrl}/asset` });
        const mw = middleware({ cacheDir });
        let nextErr;
        let nexted = false;
        await mw(res.__req, res, err => {
          nextErr = err;
          nexted = true;
        });

        expect(nextErr, "no error to next()").to.equal(undefined);
        expect(nexted, "middleware continued via next()").to.equal(true);
        expect(stub.calledTwice, "cacheAsset retried exactly once").to.equal(
          true
        );
        expect(res.locals.buffer.equals(ASSET)).to.equal(true);
        expect(res.locals.contentType).to.equal("image/png");
      });

      it("does not retry a non-ENOENT read error; surfaces a 500", async function() {
        const stub = sinon.stub(middleware, "cacheAsset").resolves({
          status: "cached",
          fromCache: true,
          path: path.join(cacheDir, "whatever"),
          contentType: "image/png",
          contentLength: "10"
        });
        const eacces = new Error("EACCES: permission denied");
        eacces.code = "EACCES";
        sinon.stub(fs, "readFileSync").throws(eacces);

        const res = makeStrictRes({ fetchUrl: `${baseUrl}/asset` });
        const mw = middleware({ cacheDir });
        let nexted = false;
        await mw(res.__req, res, () => {
          nexted = true;
        });

        expect(stub.calledOnce, "no retry for a non-ENOENT error").to.equal(
          true
        );
        expect(nexted).to.equal(false);
        expect(res.statusCode).to.equal(500);
      });

      it("500s when the re-fetch still cannot be read", async function() {
        const missing = path.join(cacheDir, "still-gone");
        const stub = sinon.stub(middleware, "cacheAsset").resolves({
          status: "cached",
          fromCache: true,
          path: missing, // both the initial selection and the retry are gone
          contentType: "image/png",
          contentLength: "10"
        });

        const res = makeStrictRes({ fetchUrl: `${baseUrl}/asset` });
        const mw = middleware({ cacheDir });
        let nexted = false;
        await mw(res.__req, res, () => {
          nexted = true;
        });

        expect(stub.calledTwice, "retried once, then gave up").to.equal(true);
        expect(nexted).to.equal(false);
        expect(res.statusCode).to.equal(500);
      });
    });
  });
});
