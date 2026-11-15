import { serverModuleAction } from "./actions";
import { cachedModuleFunction } from "./cached";

self.postMessage(["WORKER_SOURCE_MARKER", typeof serverModuleAction, typeof cachedModuleFunction]);
