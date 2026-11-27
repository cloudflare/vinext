// V8 names the frame here: `at makeConfig (…/named-function.js:4:…)`.
function makeConfig() {
  return {
    plugins: [require("node:path").posix.join("named", "function")],
  };
}
const config = makeConfig();
module.exports = config;
