import * as chai from "chai";
import sinon from "sinon";
import sinonChai from "sinon-chai";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import crypto from "crypto";

import middleware from "../index.js";

const expect = chai.expect;
chai.use(sinonChai);

// The documented entry point for non-Express callers.
const { cacheAsset } = middleware;

// Tests for the standalone cacheAsset(url, opts) API (issue #48): the
// fetch+cache core without an Express req/res. Like streaming.test.mjs these
// run against a real local HTTP server and a real temp cache directory.
describe("cacheAsset (integration)", function() {
  const ASSET = crypto.randomBytes(64 * 1024); // 64 KiB

  let server;
  let baseUrl;
  let cacheDir;
  let originalEvict;
  let hits; // upstream request count per URL path

  before(function(done) {
    // See streaming.test.mjs: eviction's async folder scan races the per-test
    // temp dir cleanup. It has its own coverage there.
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
      } else if (req.url === "/chunked") {
        // No Content-Length -> chunked transfer encoding -> total is null.
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.write(ASSET.subarray(0, ASSET.length / 2));
        res.write(ASSET.subarray(ASSET.length / 2));
        res.end();
      } else if (req.url === "/truncated") {
        // Promises a full body, then dies mid-stream.
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": ASSET.length
        });
        res.write(ASSET.subarray(0, 1024));
        res.destroy();
      } else if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
      } else if (req.url === "/404") {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<h1>Not Found</h1>");
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
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-asset-test-"));
  });

  afterEach(function() {
    sinon.restore();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    // The coalescing map drains itself, but clear it defensively so a test
    // that threw mid-flight can't leak an entry into the next one (#54).
    middleware._inFlight.clear();
  });

  // Every file in the cache directory, temp files included.
  function cachedFiles(dir) {
    const walk = d =>
      fs.readdirSync(d).flatMap(entry => {
        const p = path.join(d, entry);
        return fs.statSync(p).isDirectory() ? walk(p) : [p];
      });
    return fs.existsSync(dir) ? walk(dir) : [];
  }

  it("caches a fresh URL and reports it as a miss", async function() {
    const result = await cacheAsset(`${baseUrl}/asset`, { cacheDir });

    expect(result.status).to.equal("cached");
    expect(result.fromCache).to.equal(false);
    expect(result.contentType).to.equal("image/png");
    expect(result.contentLength).to.equal(String(ASSET.length));

    expect(fs.existsSync(result.path), "the returned path exists").to.equal(
      true
    );
    expect(fs.readFileSync(result.path).equals(ASSET)).to.equal(true);
  });

  it("reports monotonic progress up to the total", async function() {
    const events = [];
    await cacheAsset(`${baseUrl}/asset`, {
      cacheDir,
      onProgress: ({ received, total }) => events.push({ received, total })
    });

    expect(events.length).to.be.greaterThan(0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].received).to.be.at.least(events[i - 1].received);
    }
    expect(events.every(e => e.total === ASSET.length)).to.equal(true);
    expect(events[events.length - 1].received).to.equal(ASSET.length);
  });

  it("reports a null total when upstream sends no Content-Length", async function() {
    const events = [];
    const result = await cacheAsset(`${baseUrl}/chunked`, {
      cacheDir,
      onProgress: p => events.push(p)
    });

    expect(events.every(e => e.total === null)).to.equal(true);
    // The bytes actually received are authoritative for the cached length.
    expect(result.contentLength).to.equal(String(ASSET.length));
  });

  it("serves the second call from cache without hitting the network", async function() {
    const first = await cacheAsset(`${baseUrl}/asset`, { cacheDir });
    const second = await cacheAsset(`${baseUrl}/asset`, { cacheDir });

    expect(first.fromCache).to.equal(false);
    expect(second.fromCache).to.equal(true);
    expect(second.status).to.equal("cached");
    expect(second.path).to.equal(first.path);
    expect(second.contentType).to.equal("image/png");
    expect(second.contentLength).to.equal(String(ASSET.length));
    expect(hits["/asset"], "upstream is fetched exactly once").to.equal(1);
  });

  it("touches the cached file on a hit so LRU sees the access", async function() {
    const first = await cacheAsset(`${baseUrl}/asset`, { cacheDir });
    const touchSpy = sinon.spy(middleware, "touch");

    await cacheAsset(`${baseUrl}/asset`, { cacheDir });

    expect(touchSpy).to.have.been.calledOnceWithExactly(first.path);
  });

  it("keys the cache by cacheKey when given", async function() {
    const viaKey = await cacheAsset(`${baseUrl}/asset`, {
      cacheDir,
      cacheKey: "stable-key"
    });
    // A different URL under the same key resolves to the same entry, without
    // a second upstream fetch.
    const again = await cacheAsset(`${baseUrl}/chunked`, {
      cacheDir,
      cacheKey: "stable-key"
    });

    expect(again.fromCache).to.equal(true);
    expect(again.path).to.equal(viaKey.path);
    expect(hits["/chunked"], "the second URL is never fetched").to.equal(
      undefined
    );
  });

  it("reports a non-2xx upstream as an error and caches nothing", async function() {
    const result = await cacheAsset(`${baseUrl}/404`, { cacheDir });

    expect(result.status).to.equal("error");
    expect(result.httpStatus).to.equal(404);
    expect(result.contentType).to.match(/text\/html/);
    expect(result.body).to.contain("Not Found");
    expect(cachedFiles(cacheDir), "nothing should be cached").to.deep.equal([]);
  });

  it("reports a 2xx with no body as empty and caches nothing", async function() {
    const result = await cacheAsset(`${baseUrl}/empty`, { cacheDir });

    expect(result.status).to.equal("empty");
    expect(result.httpStatus).to.equal(204);
    expect(cachedFiles(cacheDir), "nothing should be cached").to.deep.equal([]);
  });

  it("leaves no temp file behind when the download dies mid-stream", async function() {
    let rejected = null;
    try {
      await cacheAsset(`${baseUrl}/truncated`, { cacheDir });
    } catch (e) {
      rejected = e;
    }

    // node-fetch rejects with a FetchError, which chai's `an("error")` does
    // not recognise as an Error; check the prototype chain instead.
    expect(rejected, "cacheAsset should reject").to.be.instanceOf(Error);
    expect(
      cachedFiles(cacheDir),
      "no partial entry and no temp file"
    ).to.deep.equal([]);
  });

  it("leaves no temp file behind when publishing fails", async function() {
    sinon.stub(fs, "renameSync").throws(new Error("EIO"));

    let rejected = null;
    try {
      await cacheAsset(`${baseUrl}/asset`, { cacheDir });
    } catch (e) {
      rejected = e;
    }

    expect(rejected, "cacheAsset should reject").to.be.an("error");
    expect(rejected.message).to.equal("EIO");
    expect(cachedFiles(cacheDir), "the temp file is removed").to.deep.equal([]);
  });

  it("re-fetches when the cache entry is an empty directory", async function() {
    const { path: assetCachePath } = middleware.makeAssetCachePath(
      cacheDir,
      `${baseUrl}/asset`
    );
    // A corrupted entry: the directory exists but holds no file.
    fs.mkdirSync(assetCachePath, { recursive: true });

    const result = await cacheAsset(`${baseUrl}/asset`, { cacheDir });

    expect(result.status).to.equal("cached");
    expect(result.fromCache).to.equal(false);
    expect(fs.readFileSync(result.path).equals(ASSET)).to.equal(true);
  });

  // Request coalescing (issue #54): concurrent callers that resolve to the same
  // cache entry share a single upstream fetch instead of each running their own.
  describe("coalescing concurrent misses (#54)", function() {
    it("coalesces concurrent misses into a single upstream fetch", async function() {
      const [a, b] = await Promise.all([
        cacheAsset(`${baseUrl}/asset`, { cacheDir }),
        cacheAsset(`${baseUrl}/asset`, { cacheDir })
      ]);

      expect(hits["/asset"], "upstream fetched exactly once").to.equal(1);
      expect(a.status).to.equal("cached");
      expect(b.status).to.equal("cached");
      expect(a.path).to.equal(b.path);
      expect(fs.readFileSync(a.path).equals(ASSET)).to.equal(true);
      // A single published entry, and the in-flight map has drained.
      expect(cachedFiles(cacheDir).length).to.equal(1);
      expect(middleware._inFlight.size).to.equal(0);
    });

    it("shares one fetch and gives every caller the same error result", async function() {
      const [a, b] = await Promise.all([
        cacheAsset(`${baseUrl}/404`, { cacheDir }),
        cacheAsset(`${baseUrl}/404`, { cacheDir })
      ]);

      expect(hits["/404"], "upstream fetched once for both").to.equal(1);
      expect(a.status).to.equal("error");
      expect(b.status).to.equal("error");
      expect(a.httpStatus).to.equal(404);
      expect(middleware._inFlight.size).to.equal(0);
    });

    it("propagates a mid-stream failure to every coalesced caller and drains the map", async function() {
      const [a, b] = await Promise.allSettled([
        cacheAsset(`${baseUrl}/truncated`, { cacheDir }),
        cacheAsset(`${baseUrl}/truncated`, { cacheDir })
      ]);

      expect(hits["/truncated"], "one shared fetch").to.equal(1);
      expect(a.status).to.equal("rejected");
      expect(b.status).to.equal("rejected");
      // Both awaiters observe the same error instance from the shared populate.
      expect(a.reason).to.equal(b.reason);
      expect(cachedFiles(cacheDir), "no partial entry left behind").to.deep.equal(
        []
      );
      expect(middleware._inFlight.size, "map drained after rejection").to.equal(
        0
      );
    });

    it("does not coalesce calls that resolve to different cache entries", async function() {
      const [a, b] = await Promise.all([
        cacheAsset(`${baseUrl}/asset`, { cacheDir, cacheKey: "k1" }),
        cacheAsset(`${baseUrl}/asset`, { cacheDir, cacheKey: "k2" })
      ]);

      // Same URL, different keys -> two distinct entries -> two fetches.
      expect(hits["/asset"]).to.equal(2);
      expect(a.path).to.not.equal(b.path);
      expect(middleware._inFlight.size).to.equal(0);
    });

    it("coalesces N concurrent callers into a single fetch", async function() {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          cacheAsset(`${baseUrl}/asset`, { cacheDir })
        )
      );

      expect(hits["/asset"], "one fetch for all five callers").to.equal(1);
      expect(results.every(r => r.status === "cached")).to.equal(true);
      const paths = new Set(results.map(r => r.path));
      expect(paths.size, "all share the one published entry").to.equal(1);
      expect(middleware._inFlight.size).to.equal(0);
    });

    it("gives concurrent same-key callers the first URL's content (first-wins)", async function() {
      // Same cacheKey + different URLs: consistent with the sequential cacheKey
      // contract (the second URL is never fetched), now applied deterministically
      // to the concurrent case. Promise.all invokes the /asset call first, so it
      // wins and /chunked is never fetched.
      const [a, b] = await Promise.all([
        cacheAsset(`${baseUrl}/asset`, { cacheDir, cacheKey: "shared" }),
        cacheAsset(`${baseUrl}/chunked`, { cacheDir, cacheKey: "shared" })
      ]);

      expect(a.path).to.equal(b.path);
      expect(hits["/asset"], "the winner is fetched once").to.equal(1);
      expect(hits["/chunked"], "the second URL is never fetched").to.equal(
        undefined
      );
      expect(middleware._inFlight.size).to.equal(0);
    });
  });
});
