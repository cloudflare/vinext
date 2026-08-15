export default "World";

// Preserve upstream's async-module coverage.
await 1;

// Retained from upstream as a missing-module sentinel; the Worker harness does
// not use it to assert package externalization.
if (Math.random() < 0) import("fail");
