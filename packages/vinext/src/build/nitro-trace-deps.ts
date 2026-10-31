import { toSlash } from "pathslash";
import { escapeRegExp } from "../utils/regex.js";

export type NitroTraceDep = string | RegExp;

// The RegExps `mergeNitroTraceDeps` added, so a later merge can replace them.
const addedPatterns = new WeakSet<RegExp>();

/**
 * Adds the server external packages to Nitro's `traceDeps`, so an imported
 * external stays a bare `node_modules` import in the Nitro output instead of
 * being bundled into `_libs`.
 *
 * Nitro copies every package named by a string entry into the output, whether
 * the server loads it or not (nitrojs/nitro#4391). That would ship every
 * installed default external (`typescript`, `webpack`, `playwright`, ...), so
 * each name is added as a RegExp instead, which only marks matching imports as
 * traced externals. Like Next.js output file tracing, only the externals the
 * server loads are copied (`vinext:nitro-required-externals` covers
 * `require()`). Each name is matched exactly, the same as a string entry.
 *
 * Names already listed as a string (including a `!name` opt-out, which Nitro
 * only applies to strings) are left to that entry, so this must run after
 * every Nitro module has set up its `traceDeps`. A later `!name` can't cancel
 * a RegExp, so the RegExps an earlier merge added are dropped and recomputed.
 */
export function mergeNitroTraceDeps(
  traceDeps: readonly NitroTraceDep[] | undefined,
  serverExternalPackages: readonly string[],
): NitroTraceDep[] {
  const existing = (traceDeps ?? []).filter(
    (dep) => !(dep instanceof RegExp && addedPatterns.has(dep)),
  );
  // Same selector order as Nitro: `!pkg*` negates the literal `pkg*`, not `pkg`.
  const userNames = new Set(
    existing
      .filter((dep): dep is string => typeof dep === "string")
      .map((dep) => (dep.startsWith("!") ? dep.slice(1) : dep.replace(/\*$/, ""))),
  );
  const patterns = new Set(
    existing.filter((dep): dep is RegExp => dep instanceof RegExp).map((dep) => dep.source),
  );
  const added = [...new Set(serverExternalPackages)]
    .filter((name) => !userNames.has(name))
    .map((name) => {
      const dep = new RegExp(escapeRegExp(name));
      // Nitro 3.0.260311-beta and earlier join `traceDeps` into one pattern string.
      dep.toString = () => dep.source;
      return dep;
    })
    .filter((dep) => !patterns.has(dep.source));
  for (const dep of added) addedPatterns.add(dep);
  return [...existing, ...added];
}

export type NitroTracedExternals = {
  /** The server external packages Nitro traces. */
  packages: ReadonlySet<string>;
  /** Whether a Nitro `noExternals` entry bundles an import id or resolved file. */
  bundles: (id: string) => boolean;
};

/**
 * The server externals Nitro traces. A user `!name` `traceDeps` entry keeps a
 * package out, and Nitro bundles any id or resolved file a `noExternals` entry
 * matches: a RegExp, or a string anywhere in it.
 */
export function nitroTracedExternals(
  serverExternalPackages: readonly string[],
  nitroOptions: {
    traceDeps?: readonly NitroTraceDep[];
    noExternals?: boolean | readonly (string | RegExp)[];
  } = {},
): NitroTracedExternals {
  const optedOut = new Set(
    (nitroOptions.traceDeps ?? [])
      .filter((dep): dep is string => typeof dep === "string" && dep.startsWith("!"))
      .map((dep) => dep.slice(1)),
  );
  const noExternals = (Array.isArray(nitroOptions.noExternals) ? nitroOptions.noExternals : [])
    .filter(Boolean)
    // Copied without `g`/`y`, so testing doesn't move a `lastIndex` Nitro reads too.
    .map((entry) =>
      entry instanceof RegExp
        ? new RegExp(entry.source, entry.flags.replace(/[gy]/g, ""))
        : new RegExp(escapeRegExp(toSlash(entry))),
    );
  const bundles = (id: string) => noExternals.some((pattern) => pattern.test(id));
  return {
    packages: new Set(
      serverExternalPackages.filter((name) => !optedOut.has(name) && !bundles(name)),
    ),
    bundles,
  };
}
