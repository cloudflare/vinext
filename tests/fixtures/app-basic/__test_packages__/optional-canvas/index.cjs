// Same optional-require pattern as linkedom/commonjs/canvas.cjs (#3484).
try {
  module.exports = require("canvas");
} catch {
  module.exports = { backend: "fallback" };
}
