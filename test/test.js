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
