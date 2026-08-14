export default "World";

// Preserve upstream's async-module coverage.
await 1;

// ensure it's external
if (Math.random() < 0) import("fail");
