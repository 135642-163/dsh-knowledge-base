# tesseract.js (vendored)

Source: https://github.com/naptha/tesseract.js (v6.0.1, `src/` only)
License: Apache-2.0 (see LICENSE.md)

We vendor the CommonJS `src/` tree to avoid tesseract.js's non-essential
`postinstall` (an OpenCollective banner), which pnpm >= 10 blocks by default and
therefore breaks one-click plugin installs. Runtime dependencies
(`tesseract.js-core`, `bmp-js`, `zlibjs`, `node-fetch`, ...) stay as normal
dependencies; the worker path is resolved relative to this vendored tree.
