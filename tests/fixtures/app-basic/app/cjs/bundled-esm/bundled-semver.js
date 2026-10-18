// Shape of a linked workspace package's ESM dist that inlines a CommonJS
// dependency (tsdown/rolldown output). It resolves outside node_modules but is
// already ESM: the `module`/`exports` references belong to the wrapper, and
// `require` is mentioned without ever being called.
var __commonJS = (cb, mod) =>
  function __require() {
    return (mod || (0, cb[Object.keys(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports);
  };

var require_re = __commonJS({
  "node_modules/semver/internal/re.js"(exports, module) {
    const t = (exports.t = {});
    t.FULL = "full";
    t.LOADER = typeof require === "function" ? "require" : "import";
    module.exports.src = ["1.0.0"];
  },
});

const re = require_re();
const t = re.t;
const src = re.src;

export { src, t };
