const fetch = require("node-fetch");
const crypto = require("crypto");
const sprintf = require("sprintf-js").sprintf;
const fs = require("fs");
const path = require("path");

function makeDirIfNotExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}

/* from https://github.com/segment-boneyard/hash-mod/blob/master/lib/index.js */
function integerHash(string) {
  return (string + "").split("").reduce((memo, item) => {
    return (memo * 31 * item.charCodeAt(0)) % 982451653;
  }, 7);
}

module.exports = function(options) {
  return async function(req, res, next) {
    const hash = crypto
      .createHash("sha256")
      .update(res.locals.cacheKey)
      .digest("hex");

    const quotient = Math.floor(integerHash(hash) / 0x1000);
    const bucket1 = integerHash(hash) % 0x1000;
    const bucket2 = quotient % 0x1000;

    const bucket1HexString = sprintf("%x", bucket1);
    const bucket2HexString = sprintf("%x", bucket2);

    const cachedAssetPath = path.join(
      options.cacheDir,
      bucket1HexString,
      bucket2HexString,
      hash.toString()
    );

    try {
      // node 10 supports recursive: true, but who knows?
      makeDirIfNotExists(options.cacheDir);
      makeDirIfNotExists(path.join(options.cacheDir, bucket1HexString));
      makeDirIfNotExists(
        path.join(options.cacheDir, bucket1HexString, bucket2HexString)
      );

      if (fs.existsSync(cachedAssetPath)) {
        const response = await fetch(res.locals.fetchUrl, { method: "HEAD" });

        res.locals.contentLength = response.headers.get("content-length");
        res.locals.contentType = response.headers.get("content-type");

        if (options.logger)
          options.logger.debug(`Reading buffer from path ${cachedAssetPath}`);

        res.locals.buffer = fs.readFileSync(cachedAssetPath);
      } else {
        const blob = await (await fetch(res.locals.fetchUrl)).blob();

        if (options.logger)
          options.logger.debug(`Writing buffer to path ${cachedAssetPath}`);

        res.locals.buffer = Buffer.from(await blob.arrayBuffer(), "binary");

        res.locals.contentType = blob.type;
        res.localscontentLength = blob.size;

        fs.writeFileSync(cachedAssetPath, res.locals.buffer);
      }

      next();
    } catch (e) {
      // in case fs.writeFileSync writes partial data and fails
      if (fs.existsSync(cachedAssetPath)) {
        fs.unlinkSync(cachedAssetPath);
      }

      if (options.logger)
        options.logger.error(
          `Caching asset ${res.locals.cacheKey} failed with error: ${e.message}`
        );

      res.status(500).send(e.message);
    }
  };
};
