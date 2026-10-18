// A project module with ESM exports that also calls require() and assigns
// exports.* (Next.js treats it as ESM). require() still works, but exports.*
// must not become a second `named` export next to the module's own.
const dep = require("./dep.js");
exports.named = "cjs";
const named = dep.value;
export { named };
