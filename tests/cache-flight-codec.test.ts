import { describe, expect, it } from "vite-plus/test";
import vm from "node:vm";
import { createElement } from "react";
import { loadCacheFlightCodec } from "./helpers/cache-flight-codec.js";
import { patchCacheFlightCodec } from "../packages/vinext/src/plugins/cache-flight-codec.js";
import {
  CacheFlightFormData,
  snapshotFlightReply,
  restoreFlightReply,
} from "../packages/vinext/src/shims/cache-flight-arguments.js";

// React permits one renderer per module instance; exercise both argument codecs
// using the same result renderer for the capture/result sides of the boundary.
const resultCodec = loadCacheFlightCodec();

describe("Flight cache multipart factory", () => {
  it.each(["production", "development"] as const)(
    "roundtrips captured asynchronous React elements (%s)",
    async (mode) => {
      const codec = loadCacheFlightCodec(mode);
      async function AsyncChild() {
        await Promise.resolve();
        return createElement("span", null, "async child");
      }
      for (const value of [
        createElement(AsyncChild),
        Promise.resolve(createElement("span", null, "promise child")),
      ]) {
        const captures = await codec.createFromReadableStream(
          resultCodec.renderToReadableStream([value]),
        );
        const clientReferences = codec.createClientTemporaryReferenceSet();
        const reply = await codec.encodeReply([captures], {
          temporaryReferences: clientReferences,
          formDataConstructor: CacheFlightFormData,
        });
        const serverReferences = codec.createTemporaryReferenceSet();
        const args = await codec.decodeReply(restoreFlightReply(await snapshotFlightReply(reply)), {
          temporaryReferences: serverReferences,
        });
        const result = await codec.createFromReadableStream(
          resultCodec.renderToReadableStream(args[0][0], { temporaryReferences: serverReferences }),
          { temporaryReferences: clientReferences },
        );
        expect(result).toMatchObject({ type: "span" });
      }
    },
  );

  it.each(["production", "development"] as const)(
    "is scoped to one encode call (%s)",
    async (mode) => {
      const codec = loadCacheFlightCodec(mode);
      const nativeFormData = globalThis.FormData;
      const file = new File(["x"], "blob", { type: "text/plain", lastModified: 111 });
      const form = new FormData();
      form.append("file", file);
      const [cacheReply, ordinaryReply] = (await Promise.all([
        codec.encodeReply([new Blob(["x"]), file, form], {
          formDataConstructor: CacheFlightFormData,
        }),
        codec.encodeReply([new Blob(["x"]), file, form]),
      ])) as [FormData, FormData];
      expect(globalThis.FormData).toBe(nativeFormData);
      expect(Object.getPrototypeOf(ordinaryReply)).toBe(FormData.prototype);
      expect(Object.getPrototypeOf(cacheReply)).toBe(CacheFlightFormData.prototype);
      expect((cacheReply.get("1") as File).lastModified).toBe(0);
      expect((ordinaryReply.get("1") as File).lastModified).toBeGreaterThan(0);
      const decoded = await codec.decodeReply(
        restoreFlightReply(await snapshotFlightReply(cacheReply)),
      );
      expect(decoded[1].lastModified).toBe(111);
      expect(decoded[2].get("file").lastModified).toBe(111);
    },
  );

  it("fails explicitly when an encoder upgrade changes the integration seam", () => {
    expect(() => patchCacheFlightCodec("exports.encodeReply = somethingElse;", "codec.js")).toThrow(
      "unsupported Flight cache encoder",
    );
  });

  it("preserves the React 19.3 signal argument when adding the multipart factory", async () => {
    // React 19.3 moved abort handling into processReply and renamed its callbacks.
    // These signatures are from react-server-dom-webpack@19.3.0/client.edge.
    const source = `
      function processReply(root, formFieldPrefix, temporaryReferences, onResolve, onReject, signal) {
        if (signal.aborted) return onReject(signal.reason);
        const reply = new FormData();
        reply.append("value", root);
        onResolve(reply);
      }
      exports.encodeReply = function (value, options) {
        return new Promise(function (resolve, reject) {
          processReply(
            value,
            "",
            options && options.temporaryReferences ? options.temporaryReferences : void 0,
            resolve,
            reject,
            options ? options.signal : void 0
          );
        });
      };
      function resolveToJSON(key, value) {
        switch (value.$$typeof) {
          case REACT_ELEMENT_TYPE:
            if (void 0 !== temporaryReferences && modelRoot === value)
              return (modelRoot = null), "$T";
            throw Error("React Element cannot be passed to Server Functions");
        }
      }
    `;
    const exports: {
      encodeReply?: (value: Blob, options: object) => Promise<FormData>;
    } = {};
    const patched = patchCacheFlightCodec(source, "react-19.3.js").code;
    expect(patched.match(/modelRoot === value/g)).toHaveLength(1);
    vm.runInNewContext(patched, {
      exports,
      FormData,
    });
    const encode = exports.encodeReply!;
    const signal = new AbortController().signal;
    const blob = new Blob(["test"]);
    const reply = await encode(blob, { signal, formDataConstructor: CacheFlightFormData });
    expect(Object.getPrototypeOf(reply)).toBe(CacheFlightFormData.prototype);
    expect((reply.get("value") as File).lastModified).toBe(0);
    expect(Object.getPrototypeOf(await encode(blob, { signal }))).toBe(FormData.prototype);
    await expect(
      encode(blob, {
        signal: AbortSignal.abort("aborted"),
        formDataConstructor: CacheFlightFormData,
      }),
    ).rejects.toBe("aborted");
  });
});
