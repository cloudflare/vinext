import fs from "node:fs";
import path from "pathslash";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { magicStringTransformResult } from "./transform-result.js";

const CLIENT_CODEC =
  /\/react-server-dom-(?:webpack|turbopack)-client\.edge\.(?:development|production)\.js$/;

const ELEMENT_CASE =
  /case REACT_ELEMENT_TYPE:[\s\S]*?throw Error\(\s*"React Element cannot be passed/;

/**
 * Version of the Flight codec package that owns `id`. plugin-rsc resolves the
 * app's own react-server-dom-webpack when installed and its vendored copy
 * otherwise; reading the codec file's own package.json follows that choice.
 */
export function readFlightCodecVersion(id: string): string {
  for (let dir = path.dirname(id); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (/^react-server-dom-(?:webpack|turbopack)$/.test(pkg.name ?? "") && pkg.version) {
        return pkg.version;
      }
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`vinext: cannot find the react-server-dom package version for ${id}`);
    }
  }
}

/** React 19.3 ships the branch; 0.0.0-* experimental builds track main. */
function needsElementTemporaryReferenceBackport(version: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match || version.startsWith("0.0.0-")) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major < 19 || (major === 19 && minor < 3);
}

/**
 * Backport React 19.3's root-element temporary reference branch to older Flight
 * codecs, so a "use cache" argument like `Promise<ReactElement>` encodes as a
 * temporary reference instead of throwing. Remove it once React 19.3 is the
 * minimum supported version.
 * https://github.com/facebook/react/blob/v19.3.0/packages/react-client/src/ReactFlightReplyClient.js#L486
 */
export function patchCacheFlightCodec(
  code: string,
  id: string,
  version = readFlightCodecVersion(id),
) {
  if (!needsElementTemporaryReferenceBackport(version)) return null;
  const elementCase = ELEMENT_CASE.exec(code);
  if (!elementCase) {
    throw new Error(
      `vinext: react-server-dom-webpack ${version} (${id}) is not supported. ` +
        "Upgrade react, react-dom, and react-server-dom-webpack to 19.3 or later. " +
        "If your app does not depend on react-server-dom-webpack directly, " +
        "upgrade @vitejs/plugin-rsc to 0.5.35 or later instead.",
    );
  }
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
    handler: (code: string, id: string) => patchCacheFlightCodec(code, id),
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
