// Marks the isolate as a workerd host. Imported into the router entries of
// Cloudflare and Nitro workerd builds, and into @vinext/cloudflare's Worker
// entries.
import { markWorkerdHost } from "./host-runtime.js";

markWorkerdHost();
