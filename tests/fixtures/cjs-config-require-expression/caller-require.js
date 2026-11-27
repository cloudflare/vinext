function fail() {
  // This look-alike error must not be retried because a caller mentions `require`.
  throw new ReferenceError("require is not defined in ES module scope");
}
fail(() => require("node:path"));
