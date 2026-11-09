import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { loadCacheFlightCodec } from "./helpers/cache-flight-codec.js";
import {
  snapshotFlightReply,
  restoreFlightReply,
} from "../packages/vinext/src/shims/cache-flight-arguments.js";

// React permits one renderer per module instance; exercise both argument codecs
// using the same result renderer for the capture/result sides of the boundary.
const resultCodec = loadCacheFlightCodec();

describe("Flight cache codec", () => {
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
});
