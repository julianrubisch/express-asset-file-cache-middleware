const chai = require("chai");
const sinon = require("sinon");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const sinonChai = require("sinon-chai");

const expect = chai.expect;
chai.use(sinonChai);

const middleware = require("../index");

describe("Middleware", function() {
  describe("request handler calling", function() {
    before(function() {
      sinon
        .stub(middleware, "makeDirIfNotExists")
        .withArgs(".")
        .returns(false);
      sinon.stub(fs, "mkdirSync");
      sinon
        .stub(path, "join")
        .withArgs(process.cwd(), "/tmp")
        .returns("/usr/src/app/tmp");
      sinon.stub(fetch, "Promise").resolves({
        headers: {
          get: sinon.stub()
        },
        blob: sinon.stub().returns({
          arrayBuffer: sinon.stub().resolves([])
        })
      });
      sinon.stub(middleware, "evictLeastRecentlyUsed");
      this.makePathSpy = sinon
        .stub(middleware, "makeAssetCachePath")
        .returns({ dir1: "a1", dir2: "b2", path: "./a1/b2/0123456789abcdef" });

      this.nextSpy = sinon.spy();
    });

    it("writes to the cache if file is not present", async function() {
      const writeSpy = sinon.stub(fs, "writeFileSync");
      sinon
        .stub(fs, "existsSync")
        .withArgs("./a1/b2/0123456789abcdef")
        .returns(false);
      const mw = middleware({ cacheDir: "." });

      await mw(
        {},
        { locals: { cacheKey: "###", fetchUrl: "https://www.example.org" } },
        this.nextSpy
      );

      expect(this.nextSpy).to.have.been.calledOnce;
      expect(writeSpy).to.have.been.calledWith(
        "./a1/b2/0123456789abcdef/dW5kZWZpbmVkOnVuZGVmaW5lZA==",
        Buffer.from([])
      );
    });

    it("reads from the file cache if file is present", async function() {
      const readSpy = sinon.stub(fs, "readFileSync").returns(Buffer.from([]));

      sinon
        .stub(fs, "existsSync")
        .withArgs("./a1/b2/0123456789abcdef")
        .returns(true);
      sinon
        .stub(fs, "readdirSync")
        .withArgs("./a1/b2/0123456789abcdef")
        .returns(["dW5kZWZpbmVkOnVuZGVmaW5lZA=="]);
      sinon.stub(middleware, "touch");

      const mw = middleware({ cacheDir: "." });

      await mw(
        {},
        { locals: { cacheKey: "###", fetchUrl: "https://www.example.org" } },
        this.nextSpy
      );

      expect(this.nextSpy).to.have.been.calledOnce;
      expect(readSpy)
        .to.have.been.calledWith(
          "./a1/b2/0123456789abcdef/dW5kZWZpbmVkOnVuZGVmaW5lZA=="
        )
        .and.returned(Buffer.from([]));

      fs.readdirSync.restore();
    });

    // it falls back to a default cache key
    it("falls back to a default cache key", async function() {
      sinon
        .stub(fs, "existsSync")
        .withArgs("./a1/b2/0123456789abcdef")
        .returns(false);
      const mw = middleware({ cacheDir: "." });

      await mw(
        {},
        { locals: { fetchUrl: "https://www.example.org" } },
        this.nextSpy
      );

      expect(this.nextSpy).to.have.been.calledOnce;
      expect(this.makePathSpy).to.have.been.calledWith(
        ".",
        "https://www.example.org"
      );
    });

    // it falls back to a default cache directory
    it("falls back to a default cache directory", async function() {
      sinon
        .stub(fs, "existsSync")
        .withArgs("./a1/b2/0123456789abcdef")
        .returns(false);
      const mw = middleware();

      await mw(
        {},
        { locals: { fetchUrl: "https://www.example.org" } },
        this.nextSpy
      );

      expect(this.nextSpy).to.have.been.calledOnce;
      expect(this.makePathSpy).to.have.been.calledWith(
        "/usr/src/app/tmp",
        "https://www.example.org"
      );
    });

    afterEach(function() {
      fs.existsSync.restore();
      this.nextSpy.resetHistory();
      this.makePathSpy.resetHistory();
    });

    after(function() {
      path.join.restore();
      middleware.evictLeastRecentlyUsed.restore();
    });
  });

  describe("parseByteRange", function() {
    it("returns null for missing or non-string header", function() {
      expect(middleware.parseByteRange(undefined, 100)).to.equal(null);
      expect(middleware.parseByteRange(null, 100)).to.equal(null);
      expect(middleware.parseByteRange(42, 100)).to.equal(null);
    });

    it("returns null for malformed header", function() {
      expect(middleware.parseByteRange("foo", 100)).to.equal(null);
      expect(middleware.parseByteRange("items=0-10", 100)).to.equal(null);
      expect(middleware.parseByteRange("bytes=-", 100)).to.equal(null);
    });

    it("parses bytes=start-end", function() {
      expect(middleware.parseByteRange("bytes=0-99", 1000)).to.deep.equal({
        start: 0,
        end: 99
      });
      expect(middleware.parseByteRange("bytes=500-599", 1000)).to.deep.equal({
        start: 500,
        end: 599
      });
    });

    it("parses open-ended bytes=start-", function() {
      expect(middleware.parseByteRange("bytes=100-", 1000)).to.deep.equal({
        start: 100,
        end: 999
      });
    });

    it("parses suffix range bytes=-N as last N bytes", function() {
      expect(middleware.parseByteRange("bytes=-100", 1000)).to.deep.equal({
        start: 900,
        end: 999
      });
    });

    it("clamps end to total-1 when it overflows", function() {
      expect(middleware.parseByteRange("bytes=0-99999", 1000)).to.deep.equal({
        start: 0,
        end: 999
      });
    });

    it("marks unsatisfiable when start >= total", function() {
      expect(middleware.parseByteRange("bytes=9999-", 1000)).to.deep.equal({
        unsatisfiable: true
      });
    });

    it("marks unsatisfiable when start > end", function() {
      expect(middleware.parseByteRange("bytes=500-100", 1000)).to.deep.equal({
        unsatisfiable: true
      });
    });
  });

  describe("sendBuffer", function() {
    function makeRes(buffer, contentType) {
      return {
        headers: {},
        statusCode: 200,
        locals: {
          buffer,
          contentType,
          contentLength: String(buffer.length)
        },
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
        end(body) {
          this._body = body;
          return this;
        }
      };
    }

    it("sends full body with Accept-Ranges when no Range header is present", function() {
      const buf = Buffer.from("hello world");
      const res = makeRes(buf, "text/plain");
      middleware.sendBuffer({ headers: {} }, res);

      expect(res.statusCode).to.equal(200);
      expect(res.headers["Accept-Ranges"]).to.equal("bytes");
      expect(res.headers["Content-Type"]).to.equal("text/plain");
      expect(res.headers["Content-Length"]).to.equal(String(buf.length));
      expect(res._body.equals(buf)).to.equal(true);
    });

    it("sends 206 Partial Content for a valid Range header", function() {
      const buf = Buffer.from("0123456789");
      const res = makeRes(buf, "application/octet-stream");
      middleware.sendBuffer({ headers: { range: "bytes=2-5" } }, res);

      expect(res.statusCode).to.equal(206);
      expect(res.headers["Accept-Ranges"]).to.equal("bytes");
      expect(res.headers["Content-Range"]).to.equal("bytes 2-5/10");
      expect(res.headers["Content-Length"]).to.equal(4);
      expect(res._body.toString()).to.equal("2345");
    });

    it("handles open-ended Range (bytes=N-)", function() {
      const buf = Buffer.from("0123456789");
      const res = makeRes(buf, "application/octet-stream");
      middleware.sendBuffer({ headers: { range: "bytes=7-" } }, res);

      expect(res.statusCode).to.equal(206);
      expect(res.headers["Content-Range"]).to.equal("bytes 7-9/10");
      expect(res._body.toString()).to.equal("789");
    });

    it("responds 416 for unsatisfiable Range", function() {
      const buf = Buffer.from("0123456789");
      const res = makeRes(buf, "application/octet-stream");
      middleware.sendBuffer({ headers: { range: "bytes=9999-" } }, res);

      expect(res.statusCode).to.equal(416);
      expect(res.headers["Content-Range"]).to.equal("bytes */10");
    });

    it("falls back to 200 for malformed Range header", function() {
      const buf = Buffer.from("0123456789");
      const res = makeRes(buf, "application/octet-stream");
      middleware.sendBuffer({ headers: { range: "foo" } }, res);

      expect(res.statusCode).to.equal(200);
      expect(res._body.equals(buf)).to.equal(true);
    });
  });

  describe("asset cache name en/decoding", function() {
    it("encodes contenttype and length to filename", function() {
      expect(middleware.encodeAssetCacheName("image/png", "4096")).to.equal(
        "aW1hZ2UvcG5nOjQwOTY="
      );
    });

    it("retrieves contenttype and length from filename", function() {
      expect(
        middleware.decodeAssetCacheName("aW1hZ2UvcG5nOjQwOTY=")
      ).to.deep.equal(["image/png", "4096"]);
    });
  });

  describe("evicting of least recently used files", function() {
    before(function() {
      sinon
        .stub(fs, "readdirSync")
        .withArgs("/tmp")
        .returns(["test1", "test2"])
        .withArgs("/tmp/test1")
        .returns(["foo"])
        .withArgs("/tmp/test2")
        .returns(["bar"]);
      sinon
        .stub(fs, "statSync")
        .withArgs("/tmp/test1")
        .returns({
          isDirectory() {
            return true;
          }
        })
        .withArgs("/tmp/test2")
        .returns({
          isDirectory() {
            return true;
          }
        })
        .withArgs("/tmp/test1")
        .returns({
          isDirectory() {
            return true;
          }
        })
        .withArgs("/tmp/test2")
        .returns({
          isDirectory() {
            return true;
          }
        })
        .withArgs("/tmp/test1/foo")
        .returns({
          isDirectory() {
            return false;
          },
          atime: 1000
        })
        .withArgs("/tmp/test2/bar")
        .returns({
          isDirectory() {
            return false;
          },
          atime: 2000
        });
      sinon
        .stub(path, "join")
        .withArgs("/tmp", "test1")
        .returns("/tmp/test1")
        .withArgs("/tmp/test1", "foo")
        .returns("/tmp/test1/foo")
        .withArgs("/tmp", "test2")
        .returns("/tmp/test2")
        .withArgs("/tmp/test2", "bar")
        .returns("/tmp/test2/bar");
    });

    it("returns the least recently used file", function() {
      expect(middleware.findLeastRecentlyUsed("/tmp")).to.deep.equal({
        atime: 1000,
        path: "/tmp/test1/foo"
      });
    });

    after(function() {
      fs.readdirSync.restore();
      fs.statSync.restore();
      path.join.restore();
    });
  });
});
