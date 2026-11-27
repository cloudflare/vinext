// `require` is a parameter here: this look-alike error must not be retried as CommonJS.
((require) => {
  throw new ReferenceError(`${require} is not defined in ES module scope`);
})("require");
