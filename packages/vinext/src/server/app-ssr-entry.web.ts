import { createAppSsrEntry } from "./app-ssr-entry-core.js";
import { appSsrWebRuntime } from "./app-ssr-render-runtime.web.js";

const entry = createAppSsrEntry(appSsrWebRuntime);

export const handleSsr = entry.handleSsr;
export default entry.default;
