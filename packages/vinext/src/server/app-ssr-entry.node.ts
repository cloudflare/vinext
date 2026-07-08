import { createAppSsrEntry } from "./app-ssr-entry-core.js";
import { appSsrNodeRuntime } from "./app-ssr-render-runtime.node.js";

const entry = createAppSsrEntry(appSsrNodeRuntime);

export const handleSsr = entry.handleSsr;
export default entry.default;
