// SharedWorkers use onconnect to handle incoming connections
let count = 0;
// @ts-expect-error -- SharedWorkerGlobalScope's connect event is missing from the DOM lib self type.
self.addEventListener("connect", function (e: MessageEvent) {
  const port = e.ports[0];
  void import("./worker-dep").then((mod) => {
    port.postMessage("shared-worker.ts:" + mod.default + ":" + ++count);
  });
});
