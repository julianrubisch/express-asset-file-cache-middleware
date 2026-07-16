// Regression tests for touch() (issue #42). Written as a standalone ESM file
// so it coexists with the CommonJS test/test.js on master today and with the
// ESM test/test.mjs once the streaming PR lands - no shared file to conflict
// on. Uses node:assert (not chai) so it is independent of the chai major
// version, which differs between those two branches.
import assert from "node:assert";
import sinon from "sinon";
import fs from "fs";
import os from "os";
import path from "path";

import middleware from "../index.js";

describe("touch", function() {
  let dir;

  beforeEach(function() {
    // Clear any sinon stubs an earlier suite left on fs. The CommonJS
    // test/test.js on master stubs fs methods without fully restoring them,
    // and mocha runs all spec files in one process. (The ESM test/test.mjs
    // that replaces it fixes those leaks, so this is a no-op there.)
    sinon.restore();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "touch-test-"));
  });

  afterEach(function() {
    sinon.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not truncate the cached file when utimesSync fails", function() {
    const file = path.join(dir, "asset");
    const contents = Buffer.from("important cached bytes");
    fs.writeFileSync(file, contents);

    // Force the timestamp bump to fail; the old fallback opened the file with
    // "w" here, truncating it to zero bytes.
    sinon.stub(fs, "utimesSync").throws(new Error("EPERM"));

    middleware.touch(file);

    assert.ok(
      fs.readFileSync(file).equals(contents),
      "cached file must not be truncated when utimesSync fails"
    );
  });

  it("bumps the timestamp via utimesSync on success", function() {
    const file = path.join(dir, "asset");
    fs.writeFileSync(file, Buffer.from("x"));

    const spy = sinon.spy(fs, "utimesSync");

    middleware.touch(file);

    assert.ok(spy.calledWith(file), "utimesSync should be called with the path");
  });
});
