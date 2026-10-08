import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import {
  ResponseAborted,
  signalFromNodeResponse,
} from "../packages/vinext/src/server/node-response-signal.js";

// Next.js contract: signalFromNodeResponse in
// https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/web/spec-extension/adapters/next-request.ts
function response() {
  return new ServerResponse(new IncomingMessage(new Socket()));
}

describe("Node response cancellation signal", () => {
  it("aborts with ResponseAborted when the response closes before it finishes", () => {
    const res = response();
    const signal = signalFromNodeResponse(res);
    res.emit("close");
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(ResponseAborted);
    expect(signal.reason.name).toBe("ResponseAborted");
    expect(res.listenerCount("close")).toBe(0);
  });

  it("does not abort when the response finished before closing", () => {
    const res = response();
    const signal = signalFromNodeResponse(res);
    Object.defineProperty(res, "writableFinished", { value: true });
    res.emit("finish");
    res.emit("close");
    expect(signal.aborted).toBe(false);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("returns an already aborted signal for a destroyed response", () => {
    const res = response();
    res.destroy();
    const signal = signalFromNodeResponse(res);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(ResponseAborted);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("uses the response error as the reason for an errored response", () => {
    const res = response();
    const error = new Error("socket failed");
    res.destroy(error);
    expect(signalFromNodeResponse(res).reason).toBe(error);
  });

  it("ignores the incoming request finishing", () => {
    const res = response();
    const signal = signalFromNodeResponse(res);
    res.req.emit("end");
    res.req.emit("close");
    expect(signal.aborted).toBe(false);
    res.emit("close");
    expect(signal.aborted).toBe(true);
  });
});
