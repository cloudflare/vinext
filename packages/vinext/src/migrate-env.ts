/**
 * vinext migrate-env — securely migrate environment variables from Vercel to Cloudflare.
 *
 * Pulls env vars from the Vercel REST API and uploads them to Cloudflare Workers:
 *   - Secret/encrypted/sensitive vars → `wrangler secret bulk` (temp file, securely deleted)
 *   - Plain vars → injected into wrangler.jsonc `[vars]` section
 *   - NEXT_PUBLIC_* vars → always plain (needed at build time)
 *
 * Security:
 *   - Tokens are read from env vars or stdin (never logged or written to disk)
 *   - Temp secret files use 0600 permissions and are zeroed before unlink
 *   - All child processes use execFileSync (no shell injection)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { parseArgs as nodeParseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import readline from "node:readline";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VercelEnvVar {
  /** Environment variable key */
  key: string;
  /** Decrypted value (only available if token has read access) */
  value: string;
  /** Deployment targets this var applies to */
  target: Array<"production" | "preview" | "development">;
  /** Vercel var type */
  type: "plain" | "secret" | "encrypted" | "sensitive";
  /** Whether this is a system env var */
  system?: boolean;
}

export interface MigrateEnvOptions {
  /** Project root directory */
  root: string;
  /** Vercel access token */
  vercelToken: string;
  /** Vercel project ID or name */
  project: string;
  /** Vercel team ID (for team-scoped projects) */
  teamId?: string;
  /** Filter by Vercel deployment target */
  target?: "production" | "preview" | "development";
  /** Show what would be migrated without uploading */
  dryRun?: boolean;
  /** Include Vercel system env vars (VERCEL_*, NEXT_PUBLIC_VERCEL_*) */
  includeSystem?: boolean;
  /** Also write a .env.cloudflare backup file */
  envFile?: boolean;
  /** Custom fetch function for testing */
  fetcher?: typeof fetch;
}

export interface ClassifiedVars {
  secrets: Array<{ key: string; value: string }>;
  plainVars: Array<{ key: string; value: string }>;
  skipped: Array<{ key: string; reason: string }>;
}

// ─── Vercel System Vars ──────────────────────────────────────────────────────

/** Vercel/Turborepo system env vars that have no Cloudflare equivalent */
const VERCEL_SYSTEM_PREFIXES = [
  "VERCEL_",
  "NEXT_PUBLIC_VERCEL_",
  "TURBO_",
];

const VERCEL_SYSTEM_EXACT = [
  "VERCEL",
  "CI",
  "NX_DAEMON",
];

export function isVercelSystemVar(key: string): boolean {
  if (VERCEL_SYSTEM_EXACT.includes(key)) return true;
  return VERCEL_SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// ─── CLI Arg Parsing ─────────────────────────────────────────────────────────

const migrateEnvArgOptions = {
  help:             { type: "boolean", short: "h", default: false },
  "vercel-token":   { type: "string" },
  project:          { type: "string" },
  team:             { type: "string" },
  target:           { type: "string" },
  "dry-run":        { type: "boolean", default: false },
  "include-system": { type: "boolean", default: false },
  "env-file":       { type: "boolean", default: false },
} as const;

export function parseMigrateEnvArgs(args: string[]) {
  const { values } = nodeParseArgs({ args, options: migrateEnvArgOptions, strict: true });

  const target = values.target?.trim() || undefined;
  if (target && !["production", "preview", "development"].includes(target)) {
    throw new Error(
      `Invalid --target value: "${target}". Must be one of: production, preview, development`,
    );
  }

  return {
    help: values.help,
    vercelToken: values["vercel-token"]?.trim() || undefined,
    project: values.project?.trim() || undefined,
    teamId: values.team?.trim() || undefined,
    target: target as MigrateEnvOptions["target"],
    dryRun: values["dry-run"],
    includeSystem: values["include-system"],
    envFile: values["env-file"],
  };
}

// ─── Vercel Project Detection ────────────────────────────────────────────────

/**
 * Detect the Vercel project ID from local config or package.json.
 * Checks (in order):
 *   1. `.vercel/project.json` (contains projectId from `vercel link`)
 *   2. `package.json` name field (used as project name fallback)
 */
export function detectVercelProject(root: string): string | null {
  // 1. Check .vercel/project.json
  const vercelConfigPath = path.join(root, ".vercel", "project.json");
  if (fs.existsSync(vercelConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(vercelConfigPath, "utf-8"));
      if (config.projectId && typeof config.projectId === "string") {
        return config.projectId;
      }
    } catch {
      // ignore parse errors
    }
  }

  // 2. Fall back to package.json name
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.name && typeof pkg.name === "string") {
        // Strip npm scope
        return pkg.name.replace(/^@[^/]+\//, "");
      }
    } catch {
      // ignore parse errors
    }
  }

  return null;
}



/**
 * Detect the Vercel org/team ID from `.vercel/project.json`.
 * This file is created by `vercel link` and contains both projectId and orgId.
 */
export function detectVercelOrgId(root: string): string | null {
  const vercelConfigPath = path.join(root, ".vercel", "project.json");
  if (!fs.existsSync(vercelConfigPath)) return null;

  try {
    const config = JSON.parse(fs.readFileSync(vercelConfigPath, "utf-8"));
    if (config.orgId && typeof config.orgId === "string") {
      return config.orgId;
    }
  } catch {
    // ignore parse errors
  }

  return null;
}

/**
 * Detect Vercel auth token from the global Vercel CLI config.
 *
 * The Vercel CLI stores the token in one of these locations:
 *   - `~/.config/com.vercel.cli/auth.json` (XDG-style, macOS/Linux)
 *   - `~/.vercel/auth.json` (legacy location)
 *
 * The auth.json structure: { "token": "<access-token>" }
 *
 * Note: This is a convenience fallback. Users should prefer VERCEL_TOKEN env var
 * or --vercel-token flag for security. The global config token may have broader
 * permissions than needed.
 */
export function detectVercelToken(): string | null {
  const homedir = os.homedir();

  // Possible auth.json locations (in order of preference)
  const authPaths = [
    path.join(homedir, ".config", "com.vercel.cli", "auth.json"),
    path.join(homedir, ".vercel", "auth.json"),
    // Windows fallback
    path.join(homedir, "AppData", "Roaming", "com.vercel.cli", "auth.json"),
  ];

  for (const authPath of authPaths) {
    if (!fs.existsSync(authPath)) continue;

    try {
      const config = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      // Standard format: { "token": "..." }
      if (config.token && typeof config.token === "string") {
        return config.token;
      }
      // Some versions use a nested structure: { "credentials": [{ "token": "..." }] }
      if (Array.isArray(config.credentials) && config.credentials.length > 0) {
        const cred = config.credentials[0];
        if (cred.token && typeof cred.token === "string") {
          return cred.token;
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return null;
}

// ─── Vercel CLI Detection & Env Pull ─────────────────────────────────────────

/**
 * Check if the Vercel CLI is installed and available.
 * Returns the path to the vercel binary, or null if not found.
 */
export function detectVercelCli(): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const result = execFileSync(cmd, ["vercel"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Check if the user is logged in to Vercel CLI.
 * Returns true if authenticated.
 */
export function isVercelCliAuthenticated(): boolean {
  try {
    execFileSync("vercel", ["whoami"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull environment variables using `vercel env pull`.
 *
 * This uses the Vercel CLI's built-in auth (from `vercel login`),
 * so no manual token is needed.
 *
 * @param root - Project root directory
 * @param environment - Target environment: production, preview, development
 * @returns Parsed key-value pairs from the .env file, or null if pull failed
 */
export function pullEnvWithVercelCli(
  root: string,
  environment: string = "production",
): Array<{ key: string; value: string }> | null {
  // Use a temp file to avoid overwriting any existing .env
  const tmpEnvFile = path.join(root, `.env.vercel-pull-${Date.now()}`);

  try {
    execFileSync(
      "vercel",
      ["env", "pull", tmpEnvFile, "--environment", environment, "--yes"],
      {
        cwd: root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    if (!fs.existsSync(tmpEnvFile)) {
      return null;
    }

    const content = fs.readFileSync(tmpEnvFile, "utf-8");
    return parseEnvFile(content);
  } catch {
    return null;
  } finally {
    // Clean up temp file
    try {
      if (fs.existsSync(tmpEnvFile)) fs.unlinkSync(tmpEnvFile);
    } catch {
      // ignore
    }
  }
}

/**
 * Parse a .env file content into key-value pairs.
 * Supports:
 *   - KEY=VALUE
 *   - KEY="quoted value"
 *   - KEY='single quoted value'
 *   - # comments
 *   - Empty lines
 *   - Escaped characters in double-quoted values
 */
export function parseEnvFile(content: string): Array<{ key: string; value: string }> {
  const vars: Array<{ key: string; value: string }> = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Match KEY=VALUE pattern
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1);

    // Skip invalid keys
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    // Handle quoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      // Unescape double-quoted values
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\\\/g, "\\")
          .replace(/\\"/g, '"');
      }
    }

    vars.push({ key, value });
  }

  return vars;
}

// ─── Vercel API ──────────────────────────────────────────────────────────────

/**
 * Fetch all environment variables from a Vercel project.
 * Handles pagination (Vercel returns max 100 per page).
 */
export async function fetchVercelEnvVars(
  token: string,
  projectId: string,
  teamId?: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<VercelEnvVar[]> {
  const allVars: VercelEnvVar[] = [];
  let hasMore = true;
  let offset = 0;
  const limit = 100;

  while (hasMore) {
    const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (teamId) {
      url.searchParams.set("teamId", teamId);
    }

    const response = await fetcher(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401) {
        throw new Error(
          "Vercel API authentication failed (401). Check your VERCEL_TOKEN or --vercel-token value.",
        );
      }
      if (status === 403) {
        throw new Error(
          "Vercel API access denied (403). Your token may not have permission for this project/team.",
        );
      }
      if (status === 404) {
        throw new Error(
          `Vercel project "${projectId}" not found (404). Check the --project value or .vercel/project.json.`,
        );
      }
      const body = await response.text().catch(() => "");
      throw new Error(`Vercel API error (${status}): ${body || response.statusText}`);
    }

    const data = (await response.json()) as { envs: VercelEnvVar[] };

    if (!data.envs || !Array.isArray(data.envs)) {
      throw new Error("Unexpected Vercel API response: missing envs array.");
    }

    for (const env of data.envs) {
      allVars.push({
        key: env.key,
        value: env.value ?? "",
        target: Array.isArray(env.target) ? env.target : [],
        type: env.type || "plain",
        system: env.system,
      });
    }

    if (data.envs.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
    }
  }

  return allVars;
}

// ─── Var Classification ──────────────────────────────────────────────────────

/**
 * Classify Vercel env vars into secrets, plain vars, and skipped vars.
 *
 * Rules:
 *   - NEXT_PUBLIC_* → always plain (needed at build time, must be in [vars])
 *   - type: "secret" | "encrypted" | "sensitive" → secret
 *   - type: "plain" → plain var
 *   - Vercel system vars (VERCEL_*) → skipped (unless --include-system)
 *   - Filter by --target if specified
 */
export function classifyVars(
  vars: VercelEnvVar[],
  options: {
    target?: "production" | "preview" | "development";
    includeSystem?: boolean;
  } = {},
): ClassifiedVars {
  const secrets: ClassifiedVars["secrets"] = [];
  const plainVars: ClassifiedVars["plainVars"] = [];
  const skipped: ClassifiedVars["skipped"] = [];

  // Track seen keys to handle duplicates (last wins with warning)
  const seenKeys = new Map<string, string>();

  for (const env of vars) {
    // Filter by target if specified
    if (options.target && env.target.length > 0 && !env.target.includes(options.target)) {
      skipped.push({ key: env.key, reason: `target mismatch (wanted: ${options.target})` });
      continue;
    }

    // NEXT_PUBLIC_* vars are always plain (build-time inlined).
    // They should NEVER be skipped unless they are specifically NEXT_PUBLIC_VERCEL_
    if (env.key.startsWith("NEXT_PUBLIC_")) {
      // If it's NEXT_PUBLIC_VERCEL_ and we aren't including system vars, it's skipped
      if (!options.includeSystem && env.key.startsWith("NEXT_PUBLIC_VERCEL_")) {
        skipped.push({ key: env.key, reason: "Vercel system var (use --include-system to include)" });
        continue;
      }
      
      // Track duplicates
      if (seenKeys.has(env.key)) {
        const prevDest = seenKeys.get(env.key)!;
        const secretIdx = secrets.findIndex((s) => s.key === env.key);
        if (secretIdx >= 0) secrets.splice(secretIdx, 1);
        const plainIdx = plainVars.findIndex((p) => p.key === env.key);
        if (plainIdx >= 0) plainVars.splice(plainIdx, 1);
        skipped.push({
          key: `${env.key} (duplicate)`,
          reason: `replaced previous (was: ${prevDest})`,
        });
      }

      plainVars.push({ key: env.key, value: env.value });
      seenKeys.set(env.key, "plain");
      continue;
    }

    // Skip Vercel system vars unless opted in
    if (!options.includeSystem && (env.system || isVercelSystemVar(env.key))) {
        skipped.push({ key: env.key, reason: "Vercel system var (use --include-system to include)" });
        continue;
    }

    // Track duplicates
    if (seenKeys.has(env.key)) {
      const prevDest = seenKeys.get(env.key)!;
      // Remove previous entry
      const secretIdx = secrets.findIndex((s) => s.key === env.key);
      if (secretIdx >= 0) secrets.splice(secretIdx, 1);
      const plainIdx = plainVars.findIndex((p) => p.key === env.key);
      if (plainIdx >= 0) plainVars.splice(plainIdx, 1);
      skipped.push({
        key: `${env.key} (duplicate)`,
        reason: `replaced previous (was: ${prevDest})`,
      });
    }

    // Classify by type
    if (env.type === "secret" || env.type === "encrypted" || env.type === "sensitive") {
      secrets.push({ key: env.key, value: env.value });
      seenKeys.set(env.key, "secret");
    } else {
      plainVars.push({ key: env.key, value: env.value });
      seenKeys.set(env.key, "plain");
    }
  }

  return { secrets, plainVars, skipped };
}

// ─── Cloudflare Upload ───────────────────────────────────────────────────────

/**
 * Upload secrets to Cloudflare Workers via `wrangler secret bulk`.
 * Writes a temporary JSON file with strict permissions, then executes wrangler.
 * The temp file is securely wiped (zeroed) and deleted after use.
 */
export function uploadSecrets(
  root: string,
  secrets: Array<{ key: string; value: string }>,
  workerName?: string,
  dryRun = false,
): { uploaded: number; output: string } {
  if (secrets.length === 0) {
    return { uploaded: 0, output: "No secrets to upload." };
  }

  // Build the secrets JSON object { KEY: "value", ... }
  const secretsObj: Record<string, string> = {};
  for (const s of secrets) {
    secretsObj[s.key] = s.value;
  }

  if (dryRun) {
    const keys = secrets.map((s) => s.key).join(", ");
    return {
      uploaded: 0,
      output: `[dry-run] Would upload ${secrets.length} secret(s): ${keys}`,
    };
  }

  // Write to a temp file with strict permissions
  const tmpName = `.vinext-secrets-${randomBytes(8).toString("hex")}.json`;
  const tmpPath = path.join(root, tmpName);

  try {
    const jsonContent = JSON.stringify(secretsObj);
    fs.writeFileSync(tmpPath, jsonContent, { mode: 0o600, encoding: "utf-8" });

    // Use local wrangler binary (same as deploy.ts)
    const wranglerBin = path.join(root, "node_modules", ".bin", "wrangler");

    if (!fs.existsSync(wranglerBin)) {
      throw new Error(
        `Wrangler is not installed. Run \`npm install -D wrangler\` or \`vinext deploy\` (which installs it automatically).`,
      );
    }

    const args = ["secret", "bulk", tmpPath];
    if (workerName) {
      args.push("--name", workerName);
    }

    // Use execFileSync to avoid shell injection — args are passed as an array,
    // never interpolated into a shell command string.
    try {
      const output = execFileSync(wranglerBin, args, {
        cwd: root,
        stdio: "pipe",
        encoding: "utf-8",
      });
      return { uploaded: secrets.length, output: output.trim() };
    } catch (err: any) {
      const combined = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.toLowerCase();
      const isAuthError =
        combined.includes("not authenticated") ||
        combined.includes("wrangler login") ||
        combined.includes("cloudflare_api_token");

      if (!isAuthError) {
        throw new Error(`Wrangler secret upload failed: ${err.message}`);
      }

      // Auth failure — attempt interactive login via local wrangler, then retry
      console.log("\n  Cloudflare authentication required. Launching wrangler login...\n");
      try {
        execFileSync(wranglerBin, ["login"], { cwd: root, stdio: "inherit" });
      } catch {
        throw new Error(
          `Wrangler login failed. Run \`wrangler login\` manually or set CLOUDFLARE_API_TOKEN.`,
        );
      }

      console.log("\n  Retrying secret upload...");
      const retryOutput = execFileSync(wranglerBin, args, {
        cwd: root,
        stdio: "pipe",
        encoding: "utf-8",
      });
      return { uploaded: secrets.length, output: retryOutput.trim() };
    }
  } finally {
    // Secure deletion: zero out then unlink
    secureDelete(tmpPath);
  }
}
/**
 * Securely delete a file by overwriting its contents with zeros before unlinking.
 * This provides defense-in-depth against disk forensics recovering secret values.
 */
export function secureDelete(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    // Overwrite with zeros
    const zeros = Buffer.alloc(stat.size, 0);
    fs.writeFileSync(filePath, zeros);
    // Then unlink
    fs.unlinkSync(filePath);
  } catch {
    // Best effort — try to unlink even if zeroing fails
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

// ─── Wrangler Config Var Injection ───────────────────────────────────────────

/**
 * Detect the wrangler config file in the project root.
 * Returns the path and format, or null if not found.
 */
export function detectWranglerConfig(root: string): { path: string; format: "json" | "toml" } | null {
  const jsonc = path.join(root, "wrangler.jsonc");
  if (fs.existsSync(jsonc)) return { path: jsonc, format: "json" };

  const json = path.join(root, "wrangler.json");
  if (fs.existsSync(json)) return { path: json, format: "json" };

  const toml = path.join(root, "wrangler.toml");
  if (fs.existsSync(toml)) return { path: toml, format: "toml" };

  return null;
}

/**
 * Detect the Worker name from the wrangler config file.
 */
export function detectWorkerName(root: string): string | null {
  const config = detectWranglerConfig(root);
  if (!config || config.format !== "json") return null;

  try {
    // Strip JSONC comments for parsing
    const raw = fs.readFileSync(config.path, "utf-8");
    const cleaned = stripJsonComments(raw);
    const parsed = JSON.parse(cleaned);
    return parsed.name || null;
  } catch {
    return null;
  }
}

/**
 * Strip single-line (//) and multi-line comments from JSONC content.
 * Simple implementation that handles the common cases.
 */
export function stripJsonComments(content: string): string {
  let result = "";
  let inString = false;
  let inSingleComment = false;
  let inMultiComment = false;
  let i = 0;

  while (i < content.length) {
    if (inSingleComment) {
      if (content[i] === "\n") {
        inSingleComment = false;
        result += "\n";
      }
      i++;
      continue;
    }

    if (inMultiComment) {
      if (content[i] === "*" && content[i + 1] === "/") {
        inMultiComment = false;
        i += 2;
      } else {
        if (content[i] === "\n") result += "\n";
        i++;
      }
      continue;
    }

    if (inString) {
      if (content[i] === "\\" && i + 1 < content.length) {
        result += content[i] + content[i + 1];
        i += 2;
        continue;
      }
      if (content[i] === '"') {
        inString = false;
      }
      result += content[i];
      i++;
      continue;
    }

    // Not in string or comment
    if (content[i] === '"') {
      inString = true;
      result += content[i];
      i++;
      continue;
    }

    if (content[i] === "/" && content[i + 1] === "/") {
      inSingleComment = true;
      i += 2;
      continue;
    }

    if (content[i] === "/" && content[i + 1] === "*") {
      inMultiComment = true;
      i += 2;
      continue;
    }

    result += content[i];
    i++;
  }

  return result;
}

/**
 * Inject plain vars into the wrangler config [vars] section.
 *
 * For JSON/JSONC configs: reads, merges, writes back.
 * For TOML configs: warns and suggests manual merge (TOML writing is complex).
 *
 * Returns an object with the number of vars added, conflicts found, and any warnings.
 */
export function injectPlainVars(
  root: string,
  vars: Array<{ key: string; value: string }>,
  dryRun = false,
): { added: number; conflicts: string[]; warnings: string[] } {
  if (vars.length === 0) {
    return { added: 0, conflicts: [], warnings: [] };
  }

  const config = detectWranglerConfig(root);
  const conflicts: string[] = [];
  const warnings: string[] = [];

  // No wrangler config — error, require deploy --dry-run first
  if (!config) {
    throw new Error(
      `No wrangler config found. Run \`vinext deploy --dry-run\` first to generate wrangler.jsonc.`,
    );
  }

  // TOML config — warn and skip
  if (config.format === "toml") {
    warnings.push(
      "wrangler.toml detected. Cannot auto-inject vars into TOML format. " +
      "Please add vars manually under [vars] section, or convert to wrangler.jsonc.",
    );
    return { added: 0, conflicts: [], warnings };
  }

  // JSON/JSONC config — read, merge, write
  try {
    const raw = fs.readFileSync(config.path, "utf-8");
    const cleaned = stripJsonComments(raw);
    const parsed = JSON.parse(cleaned);

    if (!parsed.vars) {
      parsed.vars = {};
    }

    let added = 0;
    for (const v of vars) {
      if (parsed.vars[v.key] !== undefined && parsed.vars[v.key] !== v.value) {
        conflicts.push(v.key);
      }
      if (!dryRun) {
        parsed.vars[v.key] = v.value;
      }
      added++;
    }

    if (!dryRun) {
      fs.writeFileSync(config.path, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    }

    if (conflicts.length > 0) {
      warnings.push(
        `${conflicts.length} var(s) already existed with different values and were overwritten: ${conflicts.join(", ")}`,
      );
    }

    return { added, conflicts, warnings };
  } catch (err) {
    throw new Error(`Failed to update ${path.basename(config.path)}: ${(err as Error).message}`);
  }
}

// ─── .env Backup ─────────────────────────────────────────────────────────────

/**
 * Write a .env.cloudflare backup file with all migrated vars.
 * Also adds .env.cloudflare to .gitignore if not already present.
 */
export function writeEnvBackup(
  root: string,
  vars: Array<{ key: string; value: string }>,
  dryRun = false,
): void {
  if (vars.length === 0) return;

  const envPath = path.join(root, ".env.cloudflare");

  const lines: string[] = [
    "# Auto-generated by vinext migrateenv",
    `# Generated at: ${new Date().toISOString()}`,
    "# This file contains all env vars migrated from Vercel.",
    "# DO NOT commit this file to version control.",
    "",
  ];

  for (const v of vars) {
    // Quote values that contain special characters or are multiline
    if (v.value.includes("\n") || v.value.includes("=") || v.value.includes('"') || v.value.includes(" ") || v.value.includes("$")) {
      // Use double quotes, escape inner quotes and backslashes
      const escaped = v.value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
      lines.push(`${v.key}="${escaped}"`);
    } else if (v.value === "") {
      lines.push(`${v.key}=`);
    } else {
      lines.push(`${v.key}=${v.value}`);
    }
  }

  lines.push(""); // trailing newline

  if (!dryRun) {
    fs.writeFileSync(envPath, lines.join("\n"), "utf-8");

    // Add to .gitignore if not already present
    const gitignorePath = path.join(root, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, "utf-8");
      if (!gitignore.includes(".env.cloudflare")) {
        fs.appendFileSync(gitignorePath, "\n# vinext migrateenv backup\n.env.cloudflare\n");
      }
    }
  }
}

// ─── Interactive Token Prompt ────────────────────────────────────────────────

/**
 * Prompt the user for a token via stdin with masking.
 * Returns the entered token string.
 */
export async function promptForToken(message: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable echo for password-like input
    if (process.stdin.isTTY) {
      process.stdout.write(message);
      process.stdin.setRawMode(true);
      let token = "";

      const onData = (data: Buffer) => {
        const char = data.toString("utf-8");
        if (char === "\n" || char === "\r") {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolve(token);
          return;
        }
        if (char === "\u0003") {
          // Ctrl+C
          process.stdin.setRawMode(false);
          rl.close();
          process.exit(1);
        }
        if (char === "\u007F" || char === "\b") {
          // Backspace
          if (token.length > 0) {
            token = token.slice(0, -1);
            process.stdout.write("\b \b");
          }
          return;
        }
        token += char;
        process.stdout.write("*");
      };

      process.stdin.on("data", onData);
    } else {
      // Non-TTY: just read a line
      rl.question(message, (answer: string) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

export async function migrateEnv(options: MigrateEnvOptions): Promise<void> {
  const root = path.resolve(options.root);

  console.log("\n  vinext migrate-env\n");

  // Step 0: Require wrangler config (created by vinext deploy --dry-run)
  const workerName = detectWorkerName(root);
  if (!workerName) {
    console.error("  Error: No wrangler config with a Worker name found.");
    console.error("  Run `vinext deploy --dry-run` first to generate wrangler.jsonc.\n");
    process.exit(1);
  }

  // Step 0b: Verify this looks like a Vercel project before going further
  if (!options.project) {
    const hasVercelDir = fs.existsSync(path.join(root, ".vercel", "project.json"));
    const hasPackageName = (() => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
        return !!pkg.name;
      } catch { return false; }
    })();

    if (!hasVercelDir && !hasPackageName) {
      console.error("  Error: This does not appear to be a Vercel project.");
      console.error("  No .vercel/project.json or package.json name found.");
      console.error("  If this is a Vercel project, use --project <id-or-name> to specify it.\n");
      process.exit(1);
    }
  }

  // Step 1: Check for Vercel CLI first (preferred approach)
  const hasVercelCli = detectVercelCli() !== null;
  let envVars: VercelEnvVar[] = [];

  if (hasVercelCli && isVercelCliAuthenticated()) {
    console.log("  ✓ Vercel CLI detected and authenticated\n");
    console.log(`  Worker name:    ${workerName}`);
    if (options.target) console.log(`  Target filter:  ${options.target}`);
    if (options.dryRun) console.log("  Mode:           DRY RUN");
    console.log();

    // Pull env vars using Vercel CLI
    const targetEnv = options.target || "production";
    console.log(`  Pulling ${targetEnv} environment variables via Vercel CLI...`);
    const pulled = pullEnvWithVercelCli(root, targetEnv);

    if (pulled && pulled.length > 0) {
      console.log(`  Found ${pulled.length} environment variable(s)\n`);

      // When using CLI, all vars come as plain key-value pairs.
      // We treat everything as secrets for Cloudflare (safer default)
      // unless the key starts with NEXT_PUBLIC_ (needs to be build-time accessible)
      const secrets: Array<{ key: string; value: string }> = [];
      const plainVars: Array<{ key: string; value: string }> = [];
      const skipped: Array<{ key: string; reason: string }> = [];

      for (const v of pulled) {
        if (v.key.startsWith("NEXT_PUBLIC_")) {
          if (!options.includeSystem && v.key.startsWith("NEXT_PUBLIC_VERCEL_")) {
            skipped.push({ key: v.key, reason: "Vercel system var" });
            continue;
          }
          plainVars.push(v);
        } else if (!options.includeSystem && isVercelSystemVar(v.key)) {
          skipped.push({ key: v.key, reason: "Vercel system var" });
        } else {
          secrets.push(v);
        }
      }

      // Print summary
      console.log("  ┌─────────────────────────────────────────────────┐");
      console.log("  │  Migration Summary                              │");
      console.log("  ├─────────────────────────────────────────────────┤");
      console.log(`  │  Secrets (wrangler secret bulk):  ${String(secrets.length).padStart(3)}          │`);
      console.log(`  │  Plain vars (wrangler.jsonc):     ${String(plainVars.length).padStart(3)}          │`);
      console.log(`  │  Skipped:                         ${String(skipped.length).padStart(3)}          │`);
      console.log("  └─────────────────────────────────────────────────┘");
      console.log();

      if (skipped.length > 0) {
        console.log("  Skipped variables:");
        for (const s of skipped) {
          console.log(`    • ${s.key} — ${s.reason}`);
        }
        console.log();
      }

      // Upload secrets
      if (secrets.length > 0) {
        console.log("  Uploading secrets to Cloudflare Workers...");
        const result = uploadSecrets(root, secrets, workerName, options.dryRun);
        if (options.dryRun) {
          console.log(`  ${result.output}`);
        } else {
          console.log(`  ✓ Uploaded ${result.uploaded} secret(s)`);
        }
        console.log();
      }

      // Inject plain vars
      if (plainVars.length > 0) {
        console.log("  Injecting plain vars into wrangler config...");
        const result = injectPlainVars(root, plainVars, options.dryRun);
        const plainKeys = plainVars.map((v) => v.key).join(", ");
        if (options.dryRun) {
          console.log(`  [dry-run] Would inject ${result.added} var(s) into wrangler config: ${plainKeys}`);
        } else {
          console.log(`  ✓ Injected ${result.added} var(s) into wrangler config: ${plainKeys}`);
        }
        for (const w of result.warnings) {
          console.log(`  ⚠ ${w}`);
        }
        console.log();
      }

      // Write backup
      if (options.envFile) {
        const allVars = [...secrets, ...plainVars];
        if (options.dryRun) {
          console.log(`  [dry-run] Would write .env.cloudflare with ${allVars.length} var(s)\n`);
        } else {
          writeEnvBackup(root, allVars);
          console.log(`  ✓ Wrote .env.cloudflare backup (${allVars.length} var(s))\n`);
        }
      }

      // Done
      console.log("  ─────────────────────────────────────────");
      if (options.dryRun) {
        console.log("  Dry run complete. No changes were made.");
      } else {
        console.log("  Migration complete!");
        console.log("  Run `vinext deploy` to deploy with the new environment variables.");
      }
      console.log("  ─────────────────────────────────────────\n");
      return;
    } else {
      console.log("  ⚠ Vercel CLI pull returned no variables, falling back to REST API...\n");
    }
  } else if (hasVercelCli && !isVercelCliAuthenticated()) {
    console.log("  ⚠ Vercel CLI found but not authenticated. Run `vercel login` or provide a token.\n");
  }

  // ─── Fallback: REST API approach ───────────────────────────────────────────

  // Step 1b: Resolve Vercel token for API
  let vercelToken = options.vercelToken;
  if (!vercelToken) {
    vercelToken = process.env.VERCEL_TOKEN ?? "";
  }
  if (!vercelToken) {
    const cliToken = detectVercelToken();
    if (cliToken) {
      vercelToken = cliToken;
      console.log("  Using token from Vercel CLI config\n");
    }
  }
  if (!vercelToken) {
    console.log("  ┌───────────────────────────────────────────────────────────┐");
    console.log("  │  Create a Vercel Access Token:                           │");
    console.log("  │  → https://vercel.com/account/tokens                     │");
    console.log("  └───────────────────────────────────────────────────────────┘\n");
    vercelToken = await promptForToken("  Paste your Vercel Access Token: ");
  }
  if (!vercelToken) {
    console.error("  Error: No Vercel token provided.");
    console.error("  Options:");
    console.error("    1. Install Vercel CLI and run: vercel login");
    console.error("    2. Set VERCEL_TOKEN env var");
    console.error("    3. Use --vercel-token <token>");
    console.error("    4. Create a token at: https://vercel.com/account/tokens\n");
    process.exit(1);
  }

  // Step 2: Resolve project ID
  let projectId: string | undefined = options.project || undefined;
  if (!projectId) {
    projectId = detectVercelProject(root) ?? undefined;
  }
  if (!projectId) {
    console.error("  Error: Could not determine Vercel project.");
    console.error("  Use --project <id-or-name>, run `vercel link` first, or add a project name to package.json.\n");
    process.exit(1);
  }

  // Step 3: Resolve team ID (orgId from .vercel/project.json serves as teamId)
  let teamId = options.teamId || process.env.VERCEL_TEAM_ID || undefined;
  if (!teamId) {
    teamId = detectVercelOrgId(root) ?? undefined;
  }

  // Worker name already resolved above

  console.log(`  Vercel project: ${projectId}`);
  if (teamId) console.log(`  Vercel team:    ${teamId}`);
  console.log(`  Worker name:    ${workerName}`);
  if (options.target) console.log(`  Target filter:  ${options.target}`);
  if (options.dryRun) console.log("  Mode:           DRY RUN");
  console.log();

  // Step 5: Fetch env vars from Vercel
  console.log("  Fetching environment variables from Vercel...");
  const fetcher = options.fetcher ?? globalThis.fetch;
  envVars = await fetchVercelEnvVars(vercelToken, projectId, teamId, fetcher);

  if (envVars.length === 0) {
    console.log("  No environment variables found in Vercel project.\n");
    return;
  }

  console.log(`  Found ${envVars.length} environment variable(s)\n`);

  // Step 6: Classify vars
  const classified = classifyVars(envVars, {
    target: options.target,
    includeSystem: options.includeSystem,
  });

  // Step 7: Print summary table
  console.log("  ┌─────────────────────────────────────────────────┐");
  console.log("  │  Migration Summary                              │");
  console.log("  ├─────────────────────────────────────────────────┤");
  console.log(`  │  Secrets (wrangler secret bulk):  ${String(classified.secrets.length).padStart(3)}          │`);
  console.log(`  │  Plain vars (wrangler.jsonc):     ${String(classified.plainVars.length).padStart(3)}          │`);
  console.log(`  │  Skipped:                         ${String(classified.skipped.length).padStart(3)}          │`);
  console.log("  └─────────────────────────────────────────────────┘");
  console.log();

  // Print skipped vars
  if (classified.skipped.length > 0) {
    console.log("  Skipped variables:");
    for (const s of classified.skipped) {
      console.log(`    • ${s.key} — ${s.reason}`);
    }
    console.log();
  }

  // Step 8: Upload secrets
  if (classified.secrets.length > 0) {
    console.log("  Uploading secrets to Cloudflare Workers...");
    const result = uploadSecrets(root, classified.secrets, workerName, options.dryRun);
    if (options.dryRun) {
      console.log(`  ${result.output}`);
    } else {
      console.log(`  ✓ Uploaded ${result.uploaded} secret(s)`);
    }
    console.log();
  }

  // Step 9: Inject plain vars
  if (classified.plainVars.length > 0) {
    console.log("  Injecting plain vars into wrangler config...");
    const result = injectPlainVars(root, classified.plainVars, options.dryRun);
    const plainKeys = classified.plainVars.map((v) => v.key).join(", ");
    if (options.dryRun) {
      console.log(`  [dry-run] Would inject ${result.added} var(s) into wrangler config: ${plainKeys}`);
    } else {
      console.log(`  ✓ Injected ${result.added} var(s) into wrangler config: ${plainKeys}`);
    }
    for (const w of result.warnings) {
      console.log(`  ⚠ ${w}`);
    }
    console.log();
  }

  // Step 10: Write .env backup file
  if (options.envFile) {
    const allVars = [...classified.secrets, ...classified.plainVars];
    if (options.dryRun) {
      console.log(`  [dry-run] Would write .env.cloudflare with ${allVars.length} var(s)\n`);
    } else {
      writeEnvBackup(root, allVars);
      console.log(`  ✓ Wrote .env.cloudflare backup (${allVars.length} var(s))\n`);
    }
  }

  // Done
  console.log("  ─────────────────────────────────────────");
  if (options.dryRun) {
    console.log("  Dry run complete. No changes were made.");
  } else {
    console.log("  Migration complete!");
    console.log("  Run `vinext deploy` to deploy with the new environment variables.");
  }
  console.log("  ─────────────────────────────────────────\n");
}
