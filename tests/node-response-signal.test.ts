import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { signalFromNodeResponse } from "../packages/vinext/src/server/node-response-signal.js";

// Next.js contract: test/e2e/cancel-request and signalFromNodeResponse in
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/adapters/next-request.ts
function response() {
  return new ServerResponse(new IncomingMessage(new Socket()));
}

describe("Node response cancellation signal", () => {
  it("aborts when the client closes before a response finishes", () => {
    const res = response();
    const signal = signalFromNodeResponse(res);
    res.emit("close");
    expect(signal.aborted).toBe(true);
    expect(signal.reason.name).toBe("AbortError");
    expect(res.listenerCount("finish")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });
  it("does not abort on normal completion and releases listeners", () => {
    const res = response();
    const signal = signalFromNodeResponse(res);
    res.emit("finish");
    res.emit("close");
    expect(signal.aborted).toBe(false);
    expect(res.listenerCount("finish")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });
  it("immediately aborts an already disconnected response", () => {
    const res = response();
    res.destroy();
    expect(signalFromNodeResponse(res).aborted).toBe(true);
    expect(res.listenerCount("close")).toBe(0);
  });
  it("does not treat completed request bodies as disconnected responses", () => {
    const res = response();
    const signal = signalFromNodeResponse(res);
    res.req.emit("end");
    res.req.emit("close");
    expect(signal.aborted).toBe(false);
    res.emit("close");
    expect(signal.aborted).toBe(true);
  });
});
