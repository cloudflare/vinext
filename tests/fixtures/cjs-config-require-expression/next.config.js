// V8 reports the missing `require` at `log`, not at `require`.
console.log(require("node:path").sep);
module.exports = {
  env: { CJS_REQUIRE_EXPRESSION: "loaded" },
};
