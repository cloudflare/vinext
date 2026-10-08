#!/usr/bin/env node
/**
 * Generate a large Pages Router app into benchmarks/pages-large/{nextjs,vinext}.
 *
 * Local packages are linked through node_modules and imported through their
 * barrel files, as in a monorepo. Each package re-exports all of its modules,
 * so the first request compiles every module of every package a page touches.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = 40;
const MODULES_PER_PACKAGE = 80;
const PAGES = 30;

// Seeded PRNG (mulberry32) for deterministic source generation across runs.
function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(42);
const pick = (n) => Math.floor(random() * n);

const repositoryRoot =
  process.env.VINEXT_PERF_TARGET_ROOT ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const benchmarkRoot = join(repositoryRoot, "benchmarks");
const APP = join(benchmarkRoot, "pages-large");

// Clear the contents only: CI grants the benchmark user write access on APP itself.
mkdirSync(APP, { recursive: true });
for (const entry of readdirSync(APP)) rmSync(join(APP, entry), { recursive: true, force: true });

function write(rel, content) {
  const p = join(APP, "nextjs", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content.trimStart() + "\n");
}

const pkg = (p) => `@bench/ui-${String(p).padStart(2, "0")}`;
const component = (p, m) => `P${p}M${m}`;

// ─── Packages ──────────────────────────────────────────────────────────────────
// Package p imports only from packages below p, so the graph has no cycles.
for (let p = 0; p < PACKAGES; p++) {
  const dir = `packages/ui-${p}`;
  for (let m = 0; m < MODULES_PER_PACKAGE; m++) {
    const imports = [`import { useMemo } from "react";`];
    const children = [];
    if (m > 0) {
      const sibling = pick(m);
      imports.push(`import { ${component(p, sibling)} } from "./m${sibling}";`);
      children.push(component(p, sibling));
    }
    for (let i = 0; p > 0 && i < 3; i++) {
      const targetPackage = pick(p);
      const target = component(targetPackage, pick(MODULES_PER_PACKAGE));
      if (children.includes(target)) continue;
      imports.push(`import { ${target} } from "${pkg(targetPackage)}";`);
      children.push(target);
    }
    const styled = m % 4 === 0;
    if (styled) {
      imports.push(`import styles from "./m${m}.module.css";`);
      write(`${dir}/src/m${m}.module.css`, `.root { padding: ${(m % 3) + 1}px; }`);
    }
    write(
      `${dir}/src/m${m}.tsx`,
      `
${imports.join("\n")}

export type ${component(p, m)}Props = { depth?: number; label?: string };

function format(value: number, label: string): string {
  return \`\${label}: \${(value / 3).toFixed(2)}\`;
}

export function ${component(p, m)}({ depth = 0, label = "${component(p, m)}" }: ${component(p, m)}Props) {
  const values = useMemo(() => [${m}, ${p}, ${m + p}].map((value) => format(value, label)), [label]);
  return (
    <div${styled ? " className={styles.root}" : ""}>
      <span>{values.join(", ")}</span>
      {depth === 0 && (
        <>
          ${children.map((child) => `<${child} depth={1} />`).join("\n          ")}
        </>
      )}
    </div>
  );
}
`,
    );
  }
  write(
    `${dir}/index.ts`,
    Array.from(
      { length: MODULES_PER_PACKAGE },
      (_, m) => `export { ${component(p, m)} } from "./src/m${m}";`,
    ).join("\n"),
  );
  write(`${dir}/package.json`, JSON.stringify({ name: pkg(p), main: "index.ts" }, null, 2));
}

// ─── Pages ─────────────────────────────────────────────────────────────────────
// Pages import from the upper half of the packages, like feature code.
for (let i = 0; i < PAGES; i++) {
  // A Map drops repeated picks, which would otherwise be duplicate imports.
  const imports = new Map();
  for (let n = 0; n < 8; n++) {
    const p = PACKAGES / 2 + pick(PACKAGES / 2);
    imports.set(component(p, pick(MODULES_PER_PACKAGE)), pkg(p));
  }
  const used = [...imports];
  write(
    i === 0 ? "pages/index.tsx" : `pages/section-${i}.tsx`,
    `
${used.map(([name, from]) => `import { ${name} } from "${from}";`).join("\n")}

export default function Page() {
  return (
    <main>
      <h1>${i === 0 ? "Benchmark App" : `Section ${i}`}</h1>
      ${used.map(([name]) => `<${name} />`).join("\n      ")}
    </main>
  );
}
`,
  );
}

write(
  "pages/_app.tsx",
  `
import type { AppProps } from "next/app";
import { ${component(PACKAGES - 1, 0)} } from "${pkg(PACKAGES - 1)}";
import "../styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <${component(PACKAGES - 1, 0)} />
      <Component {...pageProps} />
    </>
  );
}
`,
);
// Like a monorepo app, the app lists its workspace packages as dependencies.
const dependencies = { next: "*", react: "*", "react-dom": "*" };
for (let p = 0; p < PACKAGES; p++) dependencies[pkg(p)] = "workspace:*";
write(
  "package.json",
  JSON.stringify({ name: "pages-large", private: true, dependencies }, null, 2),
);
write("styles/globals.css", "body { margin: 0; font-family: system-ui, sans-serif; }");
write(
  "next.config.mjs",
  `
import { fileURLToPath } from "node:url";

// node_modules entries link into benchmarks/nextjs.
export default { turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) } };
`,
);

// ─── Copy to each benchmark project ────────────────────────────────────────────
cpSync(join(APP, "nextjs"), join(APP, "vinext"), { recursive: true });
// Each copy takes its project's tsconfig, so Next.js does not rewrite it on the first round.
for (const project of ["nextjs", "vinext"]) {
  cpSync(join(benchmarkRoot, project, "tsconfig.json"), join(APP, project, "tsconfig.json"));
}
writeFileSync(
  join(APP, "vinext", "vite.config.mjs"),
  `import vinext from "vinext";\n\nexport default { plugins: [vinext()] };\n`,
);
for (const project of ["nextjs", "vinext"]) {
  const nodeModules = join(APP, project, "node_modules");
  const projectNodeModules = join(benchmarkRoot, project, "node_modules");
  mkdirSync(join(nodeModules, "@bench"), { recursive: true });
  // Junctions avoid the elevated rights Windows needs for directory symlinks;
  // other platforms ignore the link type.
  // Pull request runs that skip Next.js do not install its dependencies.
  for (const entry of existsSync(projectNodeModules) ? readdirSync(projectNodeModules) : []) {
    if (!entry.startsWith(".")) {
      const target = join("..", "..", "..", project, "node_modules", entry);
      symlinkSync(target, join(nodeModules, entry), "junction");
    }
  }
  for (let p = 0; p < PACKAGES; p++) {
    symlinkSync(join("..", "..", "packages", `ui-${p}`), join(nodeModules, pkg(p)), "junction");
  }
}

console.log(
  `Generated large Pages Router app: ${PACKAGES} packages, ${PACKAGES * MODULES_PER_PACKAGE} components, ${PAGES} pages`,
);
