const fetch = require("node-fetch");
const crypto = require("crypto");
const sprintf = require("sprintf-js").sprintf;
const fs = require("fs");
const path = require("path");
const { pipeline, Transform } = require("stream");
const { promisify } = require("util");

const streamPipeline = promisify(pipeline);

// get-folder-size v5 is ESM-only, so it can't be `require`d from this
// CommonJS module (that throws ERR_REQUIRE_ESM on Node < 22). It is loaded
// lazily via dynamic import() inside evictLeastRecentlyUsed instead.

function makeDirIfNotExists(dir) {
  // recursive: true is idempotent - it creates any missing parent directories
  // and, crucially, does NOT throw if the directory already exists. That closes
  // the check-then-create TOCTOU where two concurrent callers populating the
  // same key could both pass an existsSync() check and one then throw EEXIST
  // from mkdirSync (#53).
  fs.mkdirSync(dir, { recursive: true });
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
    dir3: hash.toString(),
    path: path.join(
      cacheDir,
      bucket1HexString,
      bucket2HexString,
      hash.toString()
    )
  };
}

function encodeAssetCacheName(contentType, contentLength) {
  return Buffer.from(`${contentType}:${contentLength}`).toString("base64");
}

function decodeAssetCacheName(encodedString) {
  const decodedFileName = Buffer.from(encodedString, "base64").toString(
    "ascii"
  );
  return decodedFileName.split(":");
}

function parseByteRange(rangeHeader, totalLength) {
  if (!rangeHeader || typeof rangeHeader !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];
  let start;
  let end;

  if (startStr === "" && endStr === "") return null;

  if (startStr === "") {
    // suffix range: bytes=-N → last N bytes
    const suffix = parseInt(endStr, 10);
    if (suffix === 0) return { unsatisfiable: true };
    start = Math.max(0, totalLength - suffix);
    end = totalLength - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === "" ? totalLength - 1 : parseInt(endStr, 10);
  }

  if (start > end || start >= totalLength) {
    return { unsatisfiable: true };
  }

  if (end >= totalLength) end = totalLength - 1;

  return { start, end };
}

// A cached asset's content type is stored inside the (base64-encoded) file
// name and normally round-trips cleanly. Should a malformed name ever decode
// to something with control characters, a raw newline, or non-latin1 bytes,
// passing it to res.set() throws ERR_INVALID_CHAR and takes down the request.
// Reject anything that isn't a well-formed header token and fall back to a
// generic binary type.
function sanitizeContentType(contentType) {
  const fallback = "application/octet-stream";
  // Preserve whatever the asset was cached with, including an empty string
  // ("no content type" - unusual, but a valid header value and the behavior
  // that predates this guard). Only replace a value that would actually make
  // res.set() throw ERR_INVALID_CHAR (#51). The rejected set matches Node's own
  // header-value validation exactly: everything except tab, printable US-ASCII,
  // and latin1 obs-text (\t, 0x20-0x7e, 0x80-0xff).
  if (typeof contentType !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[^\t\x20-\x7e\x80-\xff]/.test(contentType)) return fallback;
  return contentType;
}

function sendBuffer(req, res) {
  const buffer = res.locals.buffer;
  const total = buffer.length;
  // Guard the content-type before it reaches a header. A malformed cache-name
  // could decode to a value with control/invalid characters, which would make
  // res.set() throw ERR_INVALID_CHAR (#51). Fall back to a safe default.
  const contentType = sanitizeContentType(res.locals.contentType);

  res.set("Accept-Ranges", "bytes");

  const range = parseByteRange(req.headers && req.headers.range, total);

  if (range && range.unsatisfiable) {
    res.status(416);
    res.set({
      "Content-Type": contentType,
      "Content-Range": `bytes */${total}`
    });
    return res.end();
  }

  if (range) {
    const { start, end } = range;
    const slice = buffer.subarray(start, end + 1);
    res.status(206);
    res.set({
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": slice.length
    });
    return res.end(slice, "binary");
  }

  res.set({
    "Content-Type": contentType,
    // Derive Content-Length from the buffer itself. It is always a clean,
    // non-negative integer; the base64-encoded cache-name in
    // res.locals.contentLength must not be trusted as a header value (#51).
    "Content-Length": total
  });
  res.end(buffer, "binary");
}

function touch(path) {
  const time = new Date();
  try {
    fs.utimesSync(path, time, time);
  } catch (_) {
    // Best-effort LRU timestamp bump. If utimesSync fails, leave the file
    // untouched: the previous fallback opened it with the "w" flag, which
    // truncated the cached asset to zero bytes (#42). LRU accuracy is never
    // worth corrupting a cached file.
  }
}

async function evictLeastRecentlyUsed(cacheDir, maxSize, logger) {
  // get-folder-size v5 is ESM-only; load it lazily so this CommonJS module
  // stays requireable. `.loose()` returns the size directly and ignores
  // transient read errors, which is what we want for best-effort eviction.
  const { default: getFolderSize } = await import("get-folder-size");

  try {
    let size = await getFolderSize.loose(cacheDir);

    while (size >= maxSize) {
      // find and delete the least recently used file
      const leastRecentlyUsed = findLeastRecentlyUsed(cacheDir);

      const { dir } = path.parse(leastRecentlyUsed.path);
      fs.unlinkSync(leastRecentlyUsed.path);
      fs.rmdirSync(dir);

      if (logger) {
        logger.info(`Evicted ${leastRecentlyUsed.path} from cache`);
      }

      size = await getFolderSize.loose(cacheDir);
    }
  } catch (e) {
    if (logger) {
      logger.error(e);
    }
  }
}

function findLeastRecentlyUsed(dir, result) {
  let files = fs.readdirSync(dir);
  result = result || { atime: Date.now(), path: "" };

  files.forEach(file => {
    const newBase = path.join(dir, file);

    if (fs.statSync(newBase).isDirectory()) {
      result = findLeastRecentlyUsed(newBase, result);
    } else {
      const { atime } = fs.statSync(newBase);

      if (atime < result.atime) {
        result = {
          atime,
          path: newBase
        };
      }
    }
  });

  return result;
}

/**
 * Fetch an asset and cache it on disk, or resolve it straight from the cache.
 *
 * This is the whole download/cache/progress core with no HTTP transport
 * attached, so a non-Express caller (an Electron main process, a CLI precache,
 * a queue worker) can use it directly. The middleware below is a thin adapter
 * over it.
 *
 * @param {string} fetchUrl
 * @param {object} [opts]
 * @param {string} [opts.cacheDir=<cwd>/tmp]
 * @param {string} [opts.cacheKey=fetchUrl] cache path / dedupe key
 * @param {number} [opts.maxSize=1GiB] LRU ceiling for the cache directory
 * @param {(progress: { received: number, total: number|null }) => void} [opts.onProgress]
 *   Called per chunk on a cache miss. `total` comes from Content-Length and is
 *   null when the upstream response is chunked.
 * @param {object} [opts.logger]
 * @returns {Promise<
 *   | { status: "cached", fromCache: boolean, path: string, contentType: string, contentLength: string }
 *   | { status: "error", httpStatus: number, statusText: string, contentType: string|null, body: string }
 *   | { status: "empty", httpStatus: number }
 * >}
 *   Rejects on filesystem/stream errors, after unlinking its own temp file.
 */
async function cacheAsset(fetchUrl, opts) {
  opts = opts || {};
  const cacheDir = opts.cacheDir || path.join(process.cwd(), "/tmp");
  const maxSize = opts.maxSize || 1024 * 1024 * 1024;
  const cacheKey = opts.cacheKey || fetchUrl;
  const logger = opts.logger;

  const {
    dir1,
    dir2,
    dir3,
    path: assetCachePath
  } = middleWare.makeAssetCachePath(cacheDir, cacheKey);

  // Scoped here so the catch block can clean up this call's temp file without
  // removing the shared cache directory, which a concurrent call for the same
  // key may be using.
  let tmpPath;
  const startTime = process.hrtime();

  try {
    if (fs.existsSync(assetCachePath)) {
      // Ignore in-flight temp files (`.tmp-…`) and any other dotfile. A
      // concurrent cache-miss for the same key streams to a `.tmp-…` file in
      // this very directory before atomically renaming it into place, so an
      // unfiltered readdir()[0] can hand back a half-written temp file whose
      // name base64-decodes to garbage - producing an invalid Content-Length
      // header and a truncated body (#51). Only a real cache-name entry is a
      // hit.
      const firstFile = fs
        .readdirSync(assetCachePath)
        .find(f => !f.startsWith("."));

      // A published cache entry exists: serve it.
      if (firstFile) {
        // touch file for LRU eviction
        middleWare.touch(`${assetCachePath}/${firstFile}`);

        const [contentType, contentLength] = middleWare.decodeAssetCacheName(
          firstFile
        );

        const [seconds, nanoSeconds] = process.hrtime(startTime);
        if (logger)
          logger.info(
            `Cache hit for path ${assetCachePath}/${firstFile} in ${seconds *
              1000 +
              nanoSeconds / 1e6} ms`
          );

        return {
          status: "cached",
          fromCache: true,
          path: `${assetCachePath}/${firstFile}`,
          contentType,
          contentLength
        };
      }

      // The directory exists but holds no published entry yet - it is empty,
      // or a concurrent writer's `.tmp-…` file is the only thing in it. Either
      // way this is a miss: fall through to the fetch path below. We never
      // rmdir it or touch the temp file; the concurrent writer owns that file
      // and renames it into place when its download completes.
    }

    const response = await fetch(fetchUrl);

    // Never cache non-2xx responses: report the upstream status, content-type
    // and body so the caller can surface the real error. Reading the body also
    // releases the keep-alive socket. The entry self-heals on the next call.
    if (!response.ok) {
      const body = await response.text();
      return {
        status: "error",
        httpStatus: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        body
      };
    }

    // A 2xx response can carry no content to cache (204/205, or a null body).
    // Report the status and short-circuit rather than caching an empty file.
    if (response.status === 204 || response.status === 205 || !response.body) {
      return { status: "empty", httpStatus: response.status };
    }

    // node 10 supports recursive: true, but who knows?
    middleWare.makeDirIfNotExists(cacheDir);
    middleWare.makeDirIfNotExists(path.join(cacheDir, dir1));
    middleWare.makeDirIfNotExists(path.join(cacheDir, dir1, dir2));
    middleWare.makeDirIfNotExists(path.join(cacheDir, dir1, dir2, dir3));

    const contentType = response.headers.get("content-type") || "";
    const totalHeader = response.headers.get("content-length");
    const total =
      totalHeader != null && totalHeader !== ""
        ? parseInt(totalHeader, 10)
        : null;

    // Stream to a temp file in the same directory, then atomically rename into
    // place. A crashed or partial download never corrupts the cache.
    tmpPath = `${assetCachePath}/.tmp-${crypto.randomBytes(8).toString("hex")}`;

    let received = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (typeof opts.onProgress === "function") {
          opts.onProgress({ received, total });
        }
        callback(null, chunk);
      }
    });

    // On failure the outer catch removes tmpPath. A partial temp file is never
    // renamed into place, so the published cache can't be corrupted.
    await streamPipeline(response.body, counter, fs.createWriteStream(tmpPath));

    // The number of bytes actually written is authoritative (the
    // Content-Length header may be missing or wrong for chunked responses).
    const contentLength = received;
    const fileName = middleWare.encodeAssetCacheName(
      contentType,
      contentLength
    );
    const finalPath = `${assetCachePath}/${fileName}`;

    middleWare.evictLeastRecentlyUsed(cacheDir, maxSize, logger);

    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (renameErr) {
      if (renameErr.code === "EEXIST") {
        // A concurrent call for the same key already published this asset.
        // Windows rename refuses to overwrite an existing file, so drop our
        // temp copy and use the one that is already there.
        try {
          fs.unlinkSync(tmpPath);
        } catch (_) {
          // ignore cleanup errors
        }
      } else {
        throw renameErr;
      }
    }
    // The temp file is gone (renamed or unlinked); nothing left to clean up.
    tmpPath = undefined;

    const [seconds, nanoSeconds] = process.hrtime(startTime);
    if (logger)
      logger.info(
        `Wrote asset to path ${finalPath} in ${seconds * 1000 +
          nanoSeconds / 1e6} ms`
      );

    return {
      status: "cached",
      fromCache: false,
      path: finalPath,
      contentType,
      contentLength: String(contentLength)
    };
  } catch (e) {
    // Remove only this call's partial temp file. Never remove the shared cache
    // directory: a concurrent call for the same key may have just published a
    // valid file there.
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {
        // ignore cleanup errors
      }
    }

    if (logger)
      logger.error(
        `Caching asset at ${assetCachePath} failed with error: ${e.message}`
      );

    throw e;
  }
}

const middleWare = (module.exports = function(options) {
  return async function(req, res, next) {
    options = options || {};

    try {
      const cacheOpts = {
        cacheDir: options.cacheDir,
        cacheKey: res.locals.cacheKey,
        maxSize: options.maxSize,
        onProgress: options.onProgress,
        logger: options.logger
      };
      // cacheAsset() returns a path, not bytes - the buffer is read below. If
      // the chosen file is unlinked between selection and read (LRU eviction or
      // external cleanup: a find()->readFileSync TOCTOU, #53), re-run
      // cacheAsset once and re-dispatch its FRESH result through the same
      // error/empty/cached handling. That way a retry that now sees an upstream
      // error or an empty body is forwarded properly instead of surfacing the
      // stale ENOENT as a generic 500. Bounded to a single retry; a re-fetch
      // may fire onProgress / emit logs a second time.
      let result = await middleWare.cacheAsset(res.locals.fetchUrl, cacheOpts);

      for (let attempt = 0; ; attempt++) {
        // Forward the upstream error to the client so it sees the real failure.
        // Nothing was cached; the entry self-heals on the next request.
        if (result.status === "error") {
          if (result.contentType && typeof res.set === "function") {
            // Sanitize: a broken or hostile upstream can return a content-type
            // with control characters, which would make res.set() throw
            // ERR_INVALID_CHAR (#51) - the same failure, on the error path.
            res.set("Content-Type", sanitizeContentType(result.contentType));
          }
          return res
            .status(result.httpStatus)
            .send(result.body || result.statusText || "Upstream error");
        }

        // 2xx carrying nothing to cache (204/205, or a null body).
        if (result.status === "empty") {
          return res.status(result.httpStatus).end();
        }

        res.locals.contentType = result.contentType;
        res.locals.contentLength = result.contentLength;
        try {
          res.locals.buffer = fs.readFileSync(result.path);
          break;
        } catch (readErr) {
          // Only a vanished file (ENOENT) is retriable, and only once. Any
          // other error, or a second failure, propagates to the 500 handler.
          if (readErr.code !== "ENOENT" || attempt >= 1) throw readErr;
          result = await middleWare.cacheAsset(res.locals.fetchUrl, cacheOpts);
        }
      }

      if (res && typeof res.set === "function") {
        res.set("Accept-Ranges", "bytes");
      }

      next();
    } catch (e) {
      // cacheAsset already removed its temp file and logged the cause.
      res.status(500).send(e.message);
    }
  };
});

middleWare.cacheAsset = cacheAsset;
middleWare.makeAssetCachePath = makeAssetCachePath;
middleWare.makeDirIfNotExists = makeDirIfNotExists;
middleWare.encodeAssetCacheName = encodeAssetCacheName;
middleWare.decodeAssetCacheName = decodeAssetCacheName;
middleWare.findLeastRecentlyUsed = findLeastRecentlyUsed;
middleWare.evictLeastRecentlyUsed = evictLeastRecentlyUsed;
middleWare.touch = touch;
middleWare.sendBuffer = sendBuffer;
middleWare.parseByteRange = parseByteRange;
