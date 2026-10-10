import { getActionBody } from "./server-action";

// The worker realm has no router to dispatch Server Function calls. As in
// Next.js, the call is reported as a global error and its promise never
// settles, so it never reaches the server.
const outcomes: string[] = [];
self.addEventListener("error", (event) => {
  event.preventDefault();
  outcomes.push("error");
});
void getActionBody().then(
  (result) => outcomes.push(`resolved(${result})`),
  () => outcomes.push("rejected"),
);
setTimeout(() => {
  self.postMessage(`server-action-worker.ts:${typeof getActionBody}:${outcomes.join(",")}`);
}, 0);
