# express-asset-file-cache-middleware

![Build Status](https://github.com/julianrubisch/express-asset-file-cache-middleware/workflows/Node%20CI/badge.svg)

A modest express.js middleware to locally cache assets (images, videos, audio, etc.) for faster access and proxying, for use in e.g. Electron apps.

## TL;DR

For offline use of dynamic assets, e.g. in your Electron app or local express server.

## Usage

```javascript
const express = require("express");
const fileCacheMiddleware = require("express-asset-file-cache-middleware");

const app = express();

app.get(
  "/assets/:asset_id",
  async (req, res, next) => {    
    res.locals.fetchUrl = `https://cdn.example.org/path/to/actual/asset/${req.params.asset_id}`;

    res.locals.cacheKey = `${someExpirableUniqueKey}`;
    next();
  },
  fileCacheMiddleware({ cacheDir: "/tmp" }),
  (req, res) => {
    res.set({
      "Content-Type": res.locals.contentType,
      "Content-Length": res.locals.contentLength
    });
    res.end(res.locals.buffer, "binary");
  }
);

app.listen(3000);
```

It works by fetching your asset in between two callbacks on e.g. a route, by attaching a `fetchUrl` onto `res.locals`. When the asset isn't cached on disk already, it will write it into a directory specified by the option `cacheDir`. If it finds a file that's alread there, it will use that.

Currently even when the file is present on disk, a `HEAD` request is necessary to determine `contentType` and `contentLength`, otherwise the response will fail (I will potentially mitigate this by optionally using an SQLite database, for _true_ offline use).

Note that setting `cacheKey` and `cacheDir` isn't strictly necessary, it will fall back to `res.local.fetchUrl` and `path.join(process.cwd(), "/tmp")`, respectively.

## Install

    $ npm install express-asset-file-cache-middleware
    
or

    $ yarn add express-asset-file-cache-middleware
    
## API

### Input

#### `res.locals.fetchUrl` (required)

The URL of the asset to cache.

#### `res.locals.cacheKey` (optional)

A unique, expireable cache key. If your asset contains a checksum/digest, you're already done, because it falls back to `res.locals.fetchUrl`.

### Output

To further process the response, the following entries of `res.locals` are set:

#### `res.locals.buffer`

The cached asset as a binary buffer. Most likely, you will end the request chain with

```javascript
res.end(res.locals.buffer, "binary");
```

#### `res.locals.contentType` and `res.locals.contentLength`

If you're serving your assets in the response, you'll need to set

```javascript
res.set({
  "Content-Type": res.locals.contentType,
  "Content-Length": res.locals.contentLength
});
```    
    
## Options

You can pass the following options to the middleware:

### `cacheDir` (optional)

The root directory where the file cache will be located. Falls back to `path.join(process.cwd(), "/tmp")`.

### `logger` (optional)

A logger to use for debugging, e.g. Winston, console, etc.

## Tests

Run the test suite:

```bash
# install dependencies
$ npm install

# unit tests
$ npm test
```

## License

The MIT License (MIT)

Copyright (c) 2019 Julian Rubisch
