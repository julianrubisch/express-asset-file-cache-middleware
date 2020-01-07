# express-asset-file-cache-middleware
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-2-orange.svg?style=flat-square)](#contributors-)
<!-- ALL-CONTRIBUTORS-BADGE:END -->

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
  fileCacheMiddleware({ cacheDir: "/tmp", maxSize: 10 * 1024 * 1024 * 1024 }),
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

The asset's `contentType` and `contentLength` are stored base64 encoded in the filename, thus no offline database is necessary

Note that setting `cacheKey` and `cacheDir` isn't strictly necessary, it will fall back to `res.local.fetchUrl` and `path.join(process.cwd(), "/tmp")`, respectively.

## LRU Eviction

To avoid cluttering your device, an LRU (least recently used) cache eviction strategy in place. Per default, when your cache dir grows over 1 GB of size, the least recently used (accessed) files will be evicted (deleted), until enough disk space is available again. You can change the cache dir size by specifying `options.maxSize` (in bytes) when creating the middleware.


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

### `maxSize` (optional)
The maximum size of the cache directory, from which LRU eviction is applied. Defaults to 1 GB (1024 * 1024 * 1024).


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

## Contributors ✨

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/docs/en/emoji-key)):

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tr>
    <td align="center"><a href="http://www.julianrubisch.at"><img src="https://avatars0.githubusercontent.com/u/4352208?v=4" width="100px;" alt=""/><br /><sub><b>Julian Rubisch</b></sub></a><br /><a href="https://github.com/julianrubisch/express-asset-file-cache-middleware/commits?author=julianrubisch" title="Code">💻</a></td>
    <td align="center"><a href="https://github.com/memalloc"><img src="https://avatars2.githubusercontent.com/u/7209927?v=4" width="100px;" alt=""/><br /><sub><b>memalloc</b></sub></a><br /><a href="https://github.com/julianrubisch/express-asset-file-cache-middleware/pulls?q=is%3Apr+reviewed-by%3Amemalloc" title="Reviewed Pull Requests">👀</a></td>
  </tr>
</table>

<!-- markdownlint-enable -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!
