import MagicString from "magic-string";
import type { Plugin } from "vite";
import { magicStringTransformResult } from "./transform-result.js";

const CLIENT_CODEC =
  /\/react-server-dom-(?:webpack|turbopack)-client\.edge\.(?:development|production)\.js$/;

/**
 * React's encoder has no FormData factory option. Add just that seam to the
 * installed codec, retaining its shared server-reference registry and all its
 * serialization logic. Ordinary action encoding still uses native FormData.
 * Remove this adapter when React exposes a per-call multipart factory.
 */
export function patchCacheFlightCodec(code: string, id: string) {
  // React 19.3 moves abort handling into processReply's trailing signal argument.
  const signature =
    /function processReply\(\s*root,\s*formFieldPrefix,\s*temporaryReferences,\s*(?:resolve,\s*reject|onResolve,\s*onReject,\s*signal)\s*\)/g;
  const invocation =
    /exports\.encodeReply = function \(value, options\) \{[\s\S]*?\bprocessReply\([\s\S]*?\breject(?:,\s*options \? options\.signal : void 0)?\s*\)/g;
  const declarations = [...code.matchAll(signature)];
  const calls = [...code.matchAll(invocation)];
  if (declarations.length !== 1 || calls.length !== 1) {
    throw new Error(
      `vinext: unsupported Flight cache encoder in ${id}; update the FormData adapter`,
    );
  }
  const output = new MagicString(code);
  const declaration = declarations[0]!;
  const call = calls[0]!;
  output.appendLeft(
    declaration.index + declaration[0].length - 1,
    ", FormData = globalThis.FormData",
  );
  output.appendLeft(call.index + call[0].length - 1, ", options && options.formDataConstructor");

  // Backport React's root-element temporary reference branch for lazy/promise
  // chunks. React 19.3 and Next.js 16.3.7 already contain this exact branch.
  // https://github.com/vercel/next.js/blob/v16.3.7/packages/next/src/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.edge.production.js#L281
  const elementCase =
    /case REACT_ELEMENT_TYPE:[\s\S]*?throw Error\(\s*"React Element cannot be passed/.exec(code);
  if (elementCase && !/modelRoot\s*===\s*value/.test(elementCase[0])) {
    output.appendLeft(
      elementCase.index + elementCase[0].lastIndexOf("throw Error("),
      'if (void 0 !== temporaryReferences && modelRoot === value) return (modelRoot = null), "$T";\n',
    );
  }
  return magicStringTransformResult(output, { hires: "boundary", source: id });
}

export function cacheFlightCodecPlugin(): Plugin {
  const transform = {
    filter: { id: CLIENT_CODEC },
    handler: patchCacheFlightCodec,
  };
  return {
    name: "vinext:cache-flight-codec",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "rsc",
    configEnvironment(name) {
      if (name !== "rsc") return;
      return {
        optimizeDeps: {
          rolldownOptions: {
            plugins: [{ name: "vinext:cache-flight-codec-optimizer", transform }],
          },
        },
      };
    },
    transform,
  };
}
