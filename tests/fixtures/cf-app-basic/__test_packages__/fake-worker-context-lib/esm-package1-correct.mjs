export default "World";

// Upstream has an unreachable import("fail") here to prove Node externalization.
// Workers must remain self-contained, so this port omits that unavailable module.
