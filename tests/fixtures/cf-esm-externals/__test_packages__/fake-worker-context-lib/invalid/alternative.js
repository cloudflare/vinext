module.exports = "Alternative";

// Retained from upstream as a missing-module sentinel; the Worker harness does
// not use it to assert package externalization.
if (Math.random() < 0) require("fail");
