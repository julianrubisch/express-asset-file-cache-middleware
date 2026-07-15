const chai = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const expect = chai.expect;

const middleware = require("../index");

// End-to-end regression tests for the streaming cache-miss path (issue #26).
// Unlike test/test.js these use a real local HTTP server and a real temp cache
// directory - no fs/fetch stubbing - so they exercise the actual streaming,
// atomic-rename, status-check and progress behaviour.
describe("streaming cache (integration)", function() {
  // A deterministic, non-trivial payload so checksums and lengths are meaningful.
  const ASSET = crypto.randomBytes(64 * 1024); // 64 KiB
  const ASSET_SHA = crypto
    .createHash("sha256")
    .update(ASSET)
    .digest("hex");

  let server;
  let baseUrl;
  let cacheDir;
  let originalEvict;

  before(function(done) {
    // LRU eviction runs fire-and-forget via getFolderSize; with the tiny
    // per-test temp dirs (deleted right after each test) its async scan would
    // race the cleanup and throw ENOENT. Eviction is covered by its own unit
    // test, so disable it here to keep these streaming tests deterministic.
    originalEvict = middleware.evictLeastRecentlyUsed;
    middleware.evictLeastRecentlyUsed = () => {};

    server = http.createServer((req, res) => {
      if (req.url === "/asset") {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": ASSET.length
        });
        res.end(ASSET);
      } else if (req.url === "/chunked") {
        // No Content-Length -> chunked transfer encoding.
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.write(ASSET.subarray(0, ASSET.length / 2));
        res.write(ASSET.subarray(ASSET.length / 2));
        res.end();
      } else if (req.url === "/404") {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<h1>Not Found</h1>");
      } else if (req.url === "/500") {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("<h1>Server Error</h1>");
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
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-cache-test-"));
  });

  afterEach(function() {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  // Runs the middleware once. Resolves { next: true } when next() was called
  // (cache hit or successful miss), or { ended: true } when it short-circuited
  // the response (e.g. a non-2xx upstream status).
  function run(res, options) {
    const req = res.__req || { headers: {} };
    const mw = middleware(Object.assign({ cacheDir }, options));
    let nexted = false;
    return mw(req, res, err => {
      if (err) throw err;
      nexted = true;
    }).then(() => (nexted ? { next: true } : { ended: true }));
  }

  // Minimal Express-ish res double with the surface the middleware/sendBuffer use.
  function makeRes(locals, reqHeaders) {
    return {
      locals,
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
          Object.assign(this.headers, key);
        } else {
          this.headers[key] = value;
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

  // Returns the single cached file's absolute path (or null if none).
  function findCachedFile(dir) {
    const walk = d => {
      for (const entry of fs.readdirSync(d)) {
        const p = path.join(d, entry);
        if (fs.statSync(p).isDirectory()) {
          const found = walk(p);
          if (found) return found;
        } else {
          return p;
        }
      }
      return null;
    };
    return fs.existsSync(dir) ? walk(dir) : null;
  }

  it("stores a byte-for-byte identical copy (checksum matches)", async function() {
    const res = makeRes({ fetchUrl: `${baseUrl}/asset` });
    const result = await run(res);

    expect(result.next).to.equal(true);
    const cached = findCachedFile(cacheDir);
    expect(cached, "a cache file should exist").to.be.a("string");

    const sha = crypto
      .createHash("sha256")
      .update(fs.readFileSync(cached))
      .digest("hex");
    expect(sha).to.equal(ASSET_SHA);
    expect(res.locals.buffer.equals(ASSET)).to.equal(true);
  });

  it("records the exact byte length and content type in the filename", async function() {
    const res = makeRes({ fetchUrl: `${baseUrl}/asset` });
    await run(res);

    const cached = findCachedFile(cacheDir);
    const [contentType, contentLength] = middleware.decodeAssetCacheName(
      path.basename(cached)
    );
    expect(contentType).to.equal("image/png");
    expect(contentLength).to.equal(String(ASSET.length));
    expect(res.locals.contentLength).to.equal(String(ASSET.length));
    expect(res.locals.contentType).to.equal("image/png");
  });

  it("derives an accurate length for chunked responses without Content-Length", async function() {
    const res = makeRes({ fetchUrl: `${baseUrl}/chunked` });
    await run(res);

    const cached = findCachedFile(cacheDir);
    const [, contentLength] = middleware.decodeAssetCacheName(
      path.basename(cached)
    );
    expect(contentLength).to.equal(String(ASSET.length));
    expect(res.locals.buffer.equals(ASSET)).to.equal(true);
  });

  it("never caches a 404 and self-heals on a later success", async function() {
    const res404 = makeRes({ fetchUrl: `${baseUrl}/404` });
    const result = await run(res404);

    expect(result.ended).to.equal(true);
    expect(res404.statusCode).to.equal(404);
    expect(findCachedFile(cacheDir), "nothing should be cached").to.equal(null);

    // A subsequent successful fetch for the same key now populates the cache.
    const resOk = makeRes({
      cacheKey: `${baseUrl}/404`,
      fetchUrl: `${baseUrl}/asset`
    });
    await run(resOk);
    expect(findCachedFile(cacheDir)).to.be.a("string");
  });

  it("never caches a 500 response", async function() {
    const res = makeRes({ fetchUrl: `${baseUrl}/500` });
    const result = await run(res);

    expect(result.ended).to.equal(true);
    expect(res.statusCode).to.equal(500);
    expect(findCachedFile(cacheDir)).to.equal(null);
  });

  it("serves a Range request from the cached buffer via sendBuffer", async function() {
    // First request populates the cache.
    const res1 = makeRes({ fetchUrl: `${baseUrl}/asset` });
    await run(res1);

    // Second request is a cache hit; then drive sendBuffer with a Range header.
    const res2 = makeRes({ fetchUrl: `${baseUrl}/asset` }, { range: "bytes=10-19" });
    await run(res2);

    middleware.sendBuffer(res2.__req, res2);

    expect(res2.statusCode).to.equal(206);
    expect(res2.headers["Content-Range"]).to.equal(`bytes 10-19/${ASSET.length}`);
    expect(res2.headers["Content-Length"]).to.equal(10);
    expect(res2._body.equals(ASSET.subarray(10, 20))).to.equal(true);
  });

  it("reports monotonic progress ending at the full size", async function() {
    const events = [];
    const res = makeRes({ fetchUrl: `${baseUrl}/asset` });
    await run(res, {
      onProgress: ({ received, total }) => events.push({ received, total })
    });

    expect(events.length).to.be.greaterThan(0);
    // received is non-decreasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i].received).to.be.at.least(events[i - 1].received);
    }
    // total is reported from Content-Length and matches the asset
    expect(events[events.length - 1].total).to.equal(ASSET.length);
    // final received equals the full size
    expect(events[events.length - 1].received).to.equal(ASSET.length);
  });

  it("keeps the cache valid under concurrent cache-misses (atomic rename)", async function() {
    const resA = makeRes({ fetchUrl: `${baseUrl}/asset` });
    const resB = makeRes({ fetchUrl: `${baseUrl}/asset` });

    const [ra, rb] = await Promise.all([run(resA), run(resB)]);

    expect(ra.next).to.equal(true);
    expect(rb.next).to.equal(true);
    expect(resA.locals.buffer.equals(ASSET)).to.equal(true);
    expect(resB.locals.buffer.equals(ASSET)).to.equal(true);

    // The published cache file is complete and correct (no partial/corrupt entry).
    const cached = findCachedFile(cacheDir);
    const sha = crypto
      .createHash("sha256")
      .update(fs.readFileSync(cached))
      .digest("hex");
    expect(sha).to.equal(ASSET_SHA);
  });
});
