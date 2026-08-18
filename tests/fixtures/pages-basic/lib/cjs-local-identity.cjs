const fs = require("node:fs");
const path = require("node:path");
const process = { marker: "local-process" };
const globalThis = {};

exports.dirname = __dirname;
exports.types = `${typeof __filename}:${typeof __dirname}`;
exports.consistent = path.dirname(__filename) === __dirname;
exports.shadowedProcess = process.marker;
exports.shadowedGlobalThis = Object.keys(globalThis).length === 0 ? "local-globalThis" : "wrong";
exports.filenameReadable = fs.statSync(__filename).isFile();
exports.concatenatedPath = __dirname + "/concatenated.js";
exports.userMarkerTypes =
  `${typeof globalThis.__VINEXT_EMITTED_CJS_FILENAME__}:` +
  typeof globalThis.__VINEXT_EMITTED_CJS_DIRNAME__;
