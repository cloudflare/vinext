import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { loadCacheFlightCodec } from "./helpers/cache-flight-codec.js";
import {
  patchCacheFlightCodec,
  readFlightCodecVersion,
} from "../packages/vinext/src/plugins/cache-flight-codec.js";
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

  const elementCase = `
    function resolveToJSON(key, value) {
      switch (value.$$typeof) {
        case REACT_ELEMENT_TYPE:
          if (void 0 !== temporaryReferences && -1 === key.indexOf(":")) {
            return "$T";
          }
          throw Error("React Element cannot be passed to Server Functions");
      }
    }
  `;

  it.each(["19.2.6", "19.2.8"])("backports the root-element branch for React %s", (version) => {
    const patched = patchCacheFlightCodec(elementCase, "codec.js", version);
    expect(patched?.code.match(/modelRoot === value/g)).toHaveLength(1);
  });

  it.each(["19.3.0", "19.3.0-canary-d75b0697-20261006", "0.0.0-experimental-d75b0697-20261006"])(
    "leaves React %s untouched",
    (version) => {
      expect(patchCacheFlightCodec(elementCase, "codec.js", version)).toBeNull();
    },
  );

  it("fails explicitly when an older encoder has an unknown shape", () => {
    expect(() =>
      patchCacheFlightCodec("exports.encodeReply = somethingElse;", "codec.js", "19.2.8"),
    ).toThrow("unsupported react-server-dom 19.2.8 encoder");
  });

  it("reads the version of the codec plugin-rsc resolved", () => {
    const vendored = createRequire(import.meta.url).resolve(
      "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
    );
    const vendoredVersion = JSON.parse(
      fs.readFileSync(path.join(path.dirname(vendored), "package.json"), "utf8"),
    ).version;
    expect(
      readFlightCodecVersion(
        path.join(path.dirname(vendored), "cjs/react-server-dom-webpack-client.edge.production.js"),
      ),
    ).toBe(vendoredVersion);

    // An app's own react-server-dom-webpack takes precedence over the vendored copy.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-rsdw-"));
    try {
      const pkg = path.join(root, "node_modules", "react-server-dom-webpack");
      fs.mkdirSync(path.join(pkg, "cjs"), { recursive: true });
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "react-server-dom-webpack", version: "19.3.0" }),
      );
      expect(
        readFlightCodecVersion(
          path.join(pkg, "cjs/react-server-dom-webpack-client.edge.production.js"),
        ),
      ).toBe("19.3.0");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
