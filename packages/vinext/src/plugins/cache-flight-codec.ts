import MagicString from "magic-string";
import type { Plugin } from "vite";
import { magicStringTransformResult } from "./transform-result.js";

const CLIENT_CODEC =
  /\/react-server-dom-(?:webpack|turbopack)-client\.edge\.(?:development|production)\.js$/;

/**
 * Backport React's root-element temporary reference branch for lazy/promise
 * chunks, so a "use cache" argument like `Promise<ReactElement>` encodes as a
 * temporary reference instead of throwing. React 19.3 (and the React compiled
 * into Next.js 16.2) already contain this exact branch; the patch detects it
 * and leaves those codecs untouched. Remove it once React 19.3 is the minimum.
 * https://github.com/vercel/next.js/blob/v16.3.7/packages/next/src/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.edge.production.js#L281
 */
export function patchCacheFlightCodec(code: string, id: string) {
  const elementCase =
    /case REACT_ELEMENT_TYPE:[\s\S]*?throw Error\(\s*"React Element cannot be passed/.exec(code);
  if (!elementCase || /modelRoot\s*===\s*value/.test(elementCase[0])) return null;
  const output = new MagicString(code);
  output.appendLeft(
    elementCase.index + elementCase[0].lastIndexOf("throw Error("),
    'if (void 0 !== temporaryReferences && modelRoot === value) return (modelRoot = null), "$T";\n',
  );
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
