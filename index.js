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

function makeAssetCachePath(cacheDir, cacheKey) {
  const hash = crypto
    .createHash("sha256")
    .update(cacheKey)
    .digest("hex");

  const quotient = Math.floor(integerHash(hash) / 0x1000);
  const bucket1 = integerHash(hash) % 0x1000;
  const bucket2 = quotient % 0x1000;

  const bucket1HexString = sprintf("%x", bucket1);
  const bucket2HexString = sprintf("%x", bucket2);

  return {
    dir1: bucket1HexString,
    dir2: bucket2HexString,
    path: path.join(
      cacheDir,
      bucket1HexString,
      bucket2HexString,
      hash.toString()
    )
  };
}

function makeAssetCacheName(contentType, contentLength) {
  return Buffer.from(`${contentType}:${contentLength}`).toString("base64");
}

const middleWare = (module.exports = function(options) {
  return async function(req, res, next) {
    options = options || {};
    options.cacheDir =
      options && options.cacheDir
        ? options.cacheDir
        : path.join(process.cwd(), "/tmp");

    const { dir1, dir2, path: assetCachePath } = middleWare.makeAssetCachePath(
      options.cacheDir,
      res.locals.cacheKey || res.locals.fetchUrl
    );

    try {
      // node 10 supports recursive: true, but who knows?
      middleWare.makeDirIfNotExists(options.cacheDir);
      middleWare.makeDirIfNotExists(path.join(options.cacheDir, dir1));
      middleWare.makeDirIfNotExists(path.join(options.cacheDir, dir1, dir2));

      if (fs.existsSync(assetCachePath)) {
        if (options.logger)
          options.logger.debug(`Reading buffer from path ${assetCachePath}`);

        const firstFile = fs.readdirSync(assetCachePath)[0];
        const decodedFileName = Buffer.from("firstFile", "base64").toString(
          "ascii"
        );

        const [contentType, contentLength] = decodedFileName.split(":");

        res.locals.contentLength = contentLength;
        res.locals.contentType = contentType;

        res.locals.buffer = fs.readFileSync(`${assetCachePath}/${firstFile}`);
      } else {
        const blob = await (await fetch(res.locals.fetchUrl)).blob();

        if (options.logger)
          options.logger.debug(`Writing buffer to path ${assetCachePath}`);

        res.locals.buffer = Buffer.from(await blob.arrayBuffer(), "binary");

        res.locals.contentType = blob.type;
        res.locals.contentLength = blob.size;

        fs.writeFileSync(
          `${assetCachePath}/${middleWare.makeAssetCacheName(
            blob.type,
            blob.size
          )}`,
          res.locals.buffer
        );
      }

      next();
    } catch (e) {
      console.log(e);
      // in case fs.writeFileSync writes partial data and fails
      if (fs.existsSync(assetCachePath)) {
        fs.unlinkSync(assetCachePath);
      }

      if (options.logger)
        options.logger.error(
          `Caching asset at ${assetCachePath} failed with error: ${e.message}`
        );

      res.status(500).send(e.message);
    }
  };
});

middleWare.makeAssetCachePath = makeAssetCachePath;
middleWare.makeDirIfNotExists = makeDirIfNotExists;
middleWare.makeAssetCacheName = makeAssetCacheName;
