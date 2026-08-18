// The /shallow-test page shallow-pushes this pathname. It must exist as a real
// route so a Back/Forward traversal that falls back to an RSC navigation (no
// restorable snapshot for the entry) resolves instead of 404ing.
export { default } from "../page";
