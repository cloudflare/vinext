// A CommonJS workspace package. Linked packages resolve outside node_modules.
function load(name) {
  return require(`./locales/${name}.json`);
}
exports.named = load("en").value;
