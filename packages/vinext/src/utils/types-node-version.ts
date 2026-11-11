import fs from "node:fs";
import path from "pathslash";
import { isVersionBelow } from "./react-version.js";

// vinext installs Vite 8, whose optional peer range is `@types/node@^20.19.0 || >=22.12.0`. A project
// that declares an older @types/node (the Next.js examples and create-next-app templates ship 18.x and
// early 20.x) makes npm stop with ERESOLVE while `vinext init` installs vite, leaving the project
// half migrated.
const MINIMUM_TYPES_NODE_20: [number, number, number] = [20, 19, 0];
const MINIMUM_TYPES_NODE_22: [number, number, number] = [22, 12, 0];
export const TYPES_NODE_UPGRADE = "@types/node@^22.12.0";

function isSupportedVersion(version: string): boolean {
  const major = parseInt(version.split(".")[0] ?? "", 10);
  if (major === 20) return !isVersionBelow(version, MINIMUM_TYPES_NODE_20);
  if (major >= 22) return !isVersionBelow(version, MINIMUM_TYPES_NODE_22);
  return false;
}

function readInstalledVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "node_modules", "@types", "node", "package.json"), "utf-8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * The @types/node upgrade vinext init must install before vite, or null.
 * `dev` is the section the project declares it in, so the upgrade stays where it was.
 */
export function getTypesNodeUpgrade(root: string): { spec: string; dev: boolean } | null {
  let declared: string | undefined;
  let dev = true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (typeof pkg.dependencies?.["@types/node"] === "string") {
      declared = pkg.dependencies["@types/node"];
      dev = false;
    } else {
      declared = pkg.devDependencies?.["@types/node"];
    }
  } catch {
    return null;
  }
  if (typeof declared !== "string") return null;

  // A simple range's newest match keeps its major: 18 and 21 can never install a supported version.
  // Other ranges (`latest`, `*`, unions, `workspace:`/`npm:` specifiers) are left to the installed check.
  const major = /^[~^]?(\d+)(?:\.(?:\d+|[x*])){0,2}$/.exec(declared.trim())?.[1];
  if (major !== undefined && (Number(major) < 20 || Number(major) === 21)) {
    return { spec: TYPES_NODE_UPGRADE, dev };
  }
  // An exact version, or a tilde range, stays on its minor, so one below the floor can never move above it.
  const pinned = /^(~?)(\d+)\.(\d+)(?:\.(\d+))?$/.exec(declared.trim());
  if (pinned && !isSupportedVersion(`${pinned[2]}.${pinned[3]}.${pinned[4] ?? "0"}`)) {
    return { spec: TYPES_NODE_UPGRADE, dev };
  }
  // A 20.x range, or a lockfile, can still hold a copy below the floor.
  const installed = readInstalledVersion(root);
  return installed !== null && !isSupportedVersion(installed)
    ? { spec: TYPES_NODE_UPGRADE, dev }
    : null;
}
