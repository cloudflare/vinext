import { getCacheBody } from "./use-cache";

// Like a Server Function, a cache function reference cannot be dispatched
// from the worker realm: the call is reported as a global error and its
// promise never settles, so it never reaches the server.
const outcomes: string[] = [];
self.addEventListener("error", (event) => {
  event.preventDefault();
  outcomes.push("error");
});
void getCacheBody().then(
  (result) => outcomes.push(`resolved(${result})`),
  () => outcomes.push("rejected"),
);
setTimeout(() => {
  self.postMessage(`use-cache-worker.ts:${typeof getCacheBody}:${outcomes.join(",")}`);
}, 0);
