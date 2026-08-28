import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("Usage: setup-and-start.mjs <port>");
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vinext-rsdw-free-standalone-"));
const packRoot = path.join(tempRoot, "packages");
const appRoot = path.join(tempRoot, "app");
const relocatedRoot = path.join(tempRoot, "relocated");
process.on("exit", () => fs.rmSync(tempRoot, { recursive: true, force: true }));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

async function write(relativePath, contents) {
  const outputPath = path.join(appRoot, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents);
}

async function findPackageDirectories(root, packageName) {
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.name === packageName) matches.push(entryPath);
    if (entry.isDirectory())
      matches.push(...(await findPackageDirectories(entryPath, packageName)));
  }
  return matches;
}

await mkdir(packRoot, { recursive: true });
run("vp", ["pm", "pack", "--pack-destination", packRoot], path.join(repoRoot, "packages/types"));
const vinextPackageRoot = path.join(repoRoot, "packages/vinext");
const vinextReadmePath = path.join(vinextPackageRoot, "README.md");
const vinextReadme = await readFile(vinextReadmePath);
try {
  run("vp", ["pm", "pack", "--pack-destination", packRoot], vinextPackageRoot);
} finally {
  await writeFile(vinextReadmePath, vinextReadme);
}

const tarballs = await readdir(packRoot);
const typesTarball = tarballs.find((entry) => entry.startsWith("vinext-types-"));
const vinextTarball = tarballs.find(
  (entry) => entry.startsWith("vinext-") && !entry.startsWith("vinext-types-"),
);
if (!typesTarball || !vinextTarball) {
  throw new Error(
    `Expected packed vinext and @vinext/types tarballs, found: ${tarballs.join(", ")}`,
  );
}

await write(
  "package.json",
  `${JSON.stringify(
    {
      name: "vinext-rsdw-free-standalone-e2e",
      private: true,
      type: "module",
      version: "0.0.0",
      dependencies: {
        "@vinext/types": pathToFileURL(path.join(packRoot, typesTarball)).href,
        react: "19.2.8",
        "react-dom": "19.2.8",
        vinext: pathToFileURL(path.join(packRoot, vinextTarball)).href,
      },
      devDependencies: {
        "@vitejs/plugin-react": "6.1.0",
        "@vitejs/plugin-rsc": "0.5.34",
        vite: "8.0.0",
      },
    },
    null,
    2,
  )}\n`,
);
await write("next.config.mjs", 'export default { output: "standalone" };\n');
await write(
  "vite.config.ts",
  'import { defineConfig } from "vite";\nimport vinext from "vinext";\nexport default defineConfig({ plugins: [vinext()] });\n',
);
await write(
  "app/layout.tsx",
  "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
);
await write(
  "app/actions.ts",
  '"use server";\nexport async function isolatedEcho(value: string) { return `action:${value}`; }\n',
);
await write(
  "app/client-probe.tsx",
  '"use client";\nimport { useState } from "react";\nimport { isolatedEcho } from "./actions";\nexport function ClientProbe() { const [count, setCount] = useState(0); const [result, setResult] = useState(""); return <><button id="counter" onClick={() => setCount((value) => value + 1)}>count:{count}</button><button id="action" onClick={async () => setResult(await isolatedEcho("isolated"))}>run action</button><output id="action-result">{result}</output></>; }\n',
);
await write(
  "app/page.tsx",
  'import Link from "next/link";\nimport { ClientProbe } from "./client-probe";\nexport default function Page() { return <main><h1>RSDW-free standalone</h1><ClientProbe /><Link href="/about">About</Link></main>; }\n',
);
await write(
  "app/about/page.tsx",
  'import Link from "next/link";\nexport default function About() { return <main><h1>Isolated about</h1><Link href="/">Home</Link></main>; }\n',
);

run(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
  appRoot,
);

const rsdwPackages = await findPackageDirectories(
  path.join(appRoot, "node_modules"),
  "react-server-dom-webpack",
);
if (rsdwPackages.length > 0) {
  throw new Error(`The isolated install unexpectedly contains RSDW: ${rsdwPackages.join(", ")}`);
}

run(process.execPath, [path.join(appRoot, "node_modules/vinext/dist/cli.js"), "build"], appRoot);
fs.cpSync(path.join(appRoot, "dist/standalone"), relocatedRoot, { recursive: true });
await rm(appRoot, { recursive: true, force: true });

const server = spawn(process.execPath, [path.join(relocatedRoot, "server.js")], {
  cwd: relocatedRoot,
  stdio: "inherit",
  env: { ...process.env, PORT: String(port) },
});

let forwardedSignal = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    forwardedSignal = signal;
    server.kill(signal);
  });
}

server.on("exit", (code, signal) => {
  process.exit(code ?? (signal === forwardedSignal ? 0 : 1));
});
