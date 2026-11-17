// Stands in for react-aria-components, whose subpath entries vinext optimizes
// in RSC: each one is itself a barrel. It re-exports relative modules,
// react-stately (also an app dependency, so external under ssr.external: true)
// and @react-stately/toast (installed only for this package, so bundled).
export { ToastUsed } from "./toast-used.js";
export { ToastUnused } from "./toast-unused.js";
export { UNSTABLE_ToastQueue } from "react-stately/useToastState";
export { useToastQueue } from "@react-stately/toast";
