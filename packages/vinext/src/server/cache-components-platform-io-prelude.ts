import { installCacheComponentsPlatformIoTracking } from "./cache-components-platform-io.js";

// This module is imported before any generated App Router user-module import.
// Keeping the await in a dependency (rather than the generated entry body) is
// load-bearing: ESM evaluates every static dependency before executing the
// importing module's body, so a body-level await would let user modules capture
// unwrapped Date/Math/crypto functions first.
await installCacheComponentsPlatformIoTracking();
