const path = require("node:path");
const process = { marker: "local-process" };

exports.dirname = __dirname;
exports.types = `${typeof __filename}:${typeof __dirname}`;
exports.consistent = path.dirname(__filename) === __dirname;
exports.shadowedProcess = process.marker;
exports.userMarkerTypes =
  `${typeof globalThis.__VINEXT_EMITTED_CJS_FILENAME__}:` +
  typeof globalThis.__VINEXT_EMITTED_CJS_DIRNAME__;
