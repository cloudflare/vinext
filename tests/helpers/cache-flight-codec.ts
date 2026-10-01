import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { patchCacheFlightCodec } from "../../packages/vinext/src/plugins/cache-flight-codec.js";

/** Actual installed React codecs, with the same narrow adapter used by Vite. */
export function loadCacheFlightCodec(mode: "production" | "development" = "production") {
  const require = createRequire(import.meta.url);
  const root = path.dirname(
    require.resolve("@vitejs/plugin-rsc/vendor/react-server-dom/client.edge"),
  );
  function load(kind: "client" | "server") {
    const filename = path.join(root, `cjs/react-server-dom-webpack-${kind}.edge.${mode}.js`);
    const source = fs.readFileSync(filename, "utf8");
    const code = kind === "client" ? patchCacheFlightCodec(source, filename).code : source;
    const module = { exports: {} };
    const localRequire = createRequire(filename);
    const reactServer = path.join(
      path.dirname(require.resolve("react/package.json")),
      "react.react-server.js",
    );
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(
      (id: string) =>
        kind === "server" && id === "react" ? localRequire(reactServer) : localRequire(id),
      module,
      module.exports,
    );
    // React's vendored CommonJS files do not ship declaration files.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return module.exports as any;
  }
  const client = load("client");
  const server = load("server");
  return {
    encodeReply: client.encodeReply,
    decodeReply: (body: string | FormData, options?: object) =>
      server.decodeReply(body, {}, options),
    createClientTemporaryReferenceSet: client.createTemporaryReferenceSet,
    createTemporaryReferenceSet: server.createTemporaryReferenceSet,
    renderToReadableStream: (value: unknown, options?: object) =>
      server.renderToReadableStream(value, {}, options),
    createFromReadableStream: (stream: ReadableStream, options?: object) =>
      client.createFromReadableStream(stream, {
        serverConsumerManifest: { moduleMap: {}, serverModuleMap: {}, moduleLoading: null },
        ...options,
      }),
  };
}
