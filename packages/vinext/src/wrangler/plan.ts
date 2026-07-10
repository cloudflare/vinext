import fs from "node:fs";
import path from "pathslash";
import type { CloudflareInitOptions } from "../init-platform.js";
import { resolveWranglerJsonPath } from "../utils/project.js";
import {
  getWranglerJsonImagesBinding,
  updateWranglerJsonConfigForCloudflare,
  wranglerJsonKvNamespaceNeedsId,
} from "./json.js";
import { updateWranglerTomlConfigForCloudflare } from "./toml.js";
import type { ExistingWranglerConfigUpdatePlan, WranglerConfigFormat } from "./types.js";

export type { ExistingWranglerConfigUpdatePlan } from "./types.js";

type ExistingWranglerConfig = {
  path: string;
  format: WranglerConfigFormat;
};

type ExistingWranglerConfigFile = ExistingWranglerConfig & {
  code: string;
};

function findExistingWranglerConfig(root: string): ExistingWranglerConfig | undefined {
  const jsonPath = resolveWranglerJsonPath(root);
  if (jsonPath) return { path: jsonPath, format: "json" };

  const tomlPath = path.join(root, "wrangler.toml");
  if (fs.existsSync(tomlPath)) {
    return {
      path: tomlPath,
      format: "toml",
    };
  }
  return undefined;
}

function readExistingWranglerConfig(root: string): ExistingWranglerConfigFile | undefined {
  const config = findExistingWranglerConfig(root);
  if (!config) return undefined;
  return { ...config, code: fs.readFileSync(config.path, "utf-8") };
}

export function createExistingWranglerConfigUpdatePlan(
  root: string,
  options: CloudflareInitOptions,
): ExistingWranglerConfigUpdatePlan | undefined {
  const config = readExistingWranglerConfig(root);
  if (!config) return undefined;

  if (config.format === "json") {
    const updatedCode = updateWranglerJsonConfigForCloudflare(config.code, options);
    return {
      path: config.path,
      fileName: path.basename(config.path),
      code: updatedCode,
      imagesBinding: getWranglerJsonImagesBinding(updatedCode),
      needsKvNamespaceId: wranglerJsonKvNamespaceNeedsId(updatedCode, options),
      changed: updatedCode !== config.code,
    };
  }

  try {
    const update = updateWranglerTomlConfigForCloudflare(config.code, options);
    return {
      path: config.path,
      fileName: path.basename(config.path),
      code: update.code,
      imagesBinding: update.imagesBinding,
      needsKvNamespaceId: update.needsKvNamespaceId,
      changed: update.code !== config.code,
    };
  } catch (cause) {
    throw new Error("Could not update the existing Wrangler TOML config.", { cause });
  }
}
