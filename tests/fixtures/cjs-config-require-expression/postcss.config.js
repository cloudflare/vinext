// V8 reports the missing `require` at the `[` before it, not at `require`.
const config = {
  plugins: [require("node:path").posix.join("postcss", "plugin")],
};
module.exports = config;
