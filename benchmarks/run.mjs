#!/usr/bin/env node
/**
 * Benchmark harness: compares Next.js 16 (Turbopack) vs nextcompat (Vite 7/Rollup) vs nextcompat (Vite 8/Rolldown)
 *
 * Metrics:
 *   1. Production build time (hyperfine)
 *   2. Production bundle size (total JS+CSS, gzipped)
 *   3. Dev server cold start (time to first successful HTTP 200)
 *   4. SSR throughput & TTFB (autocannon against production server)
 *   5. Memory usage (peak RSS during build and dev)
 *
 * Prerequisites: hyperfine, autocannon (npm i -g autocannon)
 * Usage: node benchmarks/run.mjs [--runs N] [--skip-build] [--skip-dev] [--skip-ssr]
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

// ─── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const RUNS = parseInt(args.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? "3", 10);
const SKIP_BUILD = args.includes("--skip-build");
const SKIP_DEV = args.includes("--skip-dev");
const SKIP_SSR = args.includes("--skip-ssr");

// ─── Helpers ───────────────────────────────────────────────────────────────────
function exec(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts });
}

function getGitHash() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8", cwd: join(__dirname, "..") }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Calculate total size of JS and CSS files in a directory (recursively).
 * Returns { raw: bytes, gzip: bytes, files: number }
 */
function bundleSize(dir) {
  let raw = 0;
  let gzip = 0;
  let files = 0;

  function walk(d) {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (/\.(js|css|mjs)$/.test(entry)) {
        const content = readFileSync(full);
        raw += content.length;
        gzip += gzipSync(content).length;
        files++;
      }
    }
  }

  walk(dir);
  return { raw, gzip, files };
}

/**
 * Wait for a URL to return HTTP 200. Returns time in ms.
 */
async function waitForServer(url, timeoutMs = 60000) {
  const start = performance.now();
  const deadline = start + timeoutMs;

  while (performance.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return performance.now() - start;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not respond within ${timeoutMs}ms`);
}

/**
 * Start a process and measure cold start time + peak RSS.
 * Returns { coldStartMs, peakRssKb, process }
 */
async function startAndMeasure(cmd, args, cwd, url) {
  let peakRssKb = 0;

  const proc = spawn(cmd, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", PORT: new URL(url).port },
  });

  // Collect stderr/stdout for debugging
  let output = "";
  proc.stdout?.on("data", (d) => (output += d.toString()));
  proc.stderr?.on("data", (d) => (output += d.toString()));

  // Poll RSS every 200ms
  const rssInterval = setInterval(() => {
    try {
      const rssLine = execSync(`ps -o rss= -p ${proc.pid}`, { encoding: "utf-8" }).trim();
      const rss = parseInt(rssLine, 10);
      if (rss > peakRssKb) peakRssKb = rss;
    } catch {
      // process may have died
    }
  }, 200);

  try {
    const coldStartMs = await waitForServer(url, 60000);
    clearInterval(rssInterval);

    // Final RSS
    try {
      const rssLine = execSync(`ps -o rss= -p ${proc.pid}`, { encoding: "utf-8" }).trim();
      const rss = parseInt(rssLine, 10);
      if (rss > peakRssKb) peakRssKb = rss;
    } catch { /* process may have died */ }

    return { coldStartMs, peakRssKb, process: proc, output };
  } catch (err) {
    clearInterval(rssInterval);
    proc.kill("SIGTERM");
    console.error("Server output:", output);
    throw err;
  }
}

function kill(proc) {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    // Wait a moment for cleanup
    try {
      execSync(`kill -0 ${proc.pid} 2>/dev/null && kill -9 ${proc.pid}`, { stdio: "ignore" });
    } catch {}
  }
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const results = {
    timestamp: new Date().toISOString(),
    gitHash: getGitHash(),
    runs: RUNS,
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpus: (await import("node:os")).cpus().length,
    },
    nextjs: {},
    nextcompat: {},
    nextcompatRolldown: {},
  };

  const nextjsDir = join(__dirname, "nextjs");
  const nextcompatDir = join(__dirname, "nextcompat");
  const rolldownDir = join(__dirname, "nextcompat-rolldown");
  const hasRolldown = existsSync(join(rolldownDir, "package.json"));

  // ─── 1. Production Build Time ──────────────────────────────────────────────
  if (!SKIP_BUILD) {
    console.log("\n=== Production Build Time ===\n");

    // Clean previous builds
    exec("rm -rf .next", { cwd: nextjsDir });
    exec("rm -rf dist", { cwd: nextcompatDir });
    if (hasRolldown) exec("rm -rf dist", { cwd: rolldownDir });

    // Ensure plugin is built
    console.log("  Building nextcompat plugin...");
    exec("npx tsc -p packages/vite-plugin-nextcompat/tsconfig.json", { cwd: join(__dirname, "..") });

    // Warmup run for all (not measured)
    console.log("  Warmup: Next.js build...");
    exec("npx next build", { cwd: nextjsDir, timeout: 120000 });
    exec("rm -rf .next", { cwd: nextjsDir });

    console.log("  Warmup: nextcompat (Rollup) build...");
    exec("npx vite build", { cwd: nextcompatDir, timeout: 120000 });
    exec("rm -rf dist", { cwd: nextcompatDir });

    if (hasRolldown) {
      console.log("  Warmup: nextcompat (Rolldown) build...");
      exec("npx vite build", { cwd: rolldownDir, timeout: 120000 });
      exec("rm -rf dist", { cwd: rolldownDir });
    }

    // Measured runs with hyperfine (separate runs per project for clean --prepare)
    console.log(`\n  Running ${RUNS} build iterations with hyperfine...\n`);

    function parseHyperfine(jsonStr) {
      const hf = JSON.parse(jsonStr);
      const r = hf.results[0];
      return {
        mean: r.mean * 1000,
        stddev: r.stddev * 1000,
        min: r.min * 1000,
        max: r.max * 1000,
      };
    }

    try {
      // Next.js
      console.log("  Timing Next.js builds...");
      const njsJson = exec(
        `hyperfine --runs ${RUNS} --prepare 'rm -rf .next' 'npx next build' --export-json /dev/stdout 2>/dev/null`,
        { cwd: nextjsDir, timeout: 600000 }
      );
      results.nextjs.buildTime = parseHyperfine(njsJson);

      // nextcompat (Rollup)
      console.log("  Timing nextcompat (Rollup) builds...");
      const ncJson = exec(
        `hyperfine --runs ${RUNS} --prepare 'rm -rf dist' 'npx vite build' --export-json /dev/stdout 2>/dev/null`,
        { cwd: nextcompatDir, timeout: 600000 }
      );
      results.nextcompat.buildTime = parseHyperfine(ncJson);

      // nextcompat (Rolldown)
      if (hasRolldown) {
        console.log("  Timing nextcompat (Rolldown) builds...");
        const rdJson = exec(
          `hyperfine --runs ${RUNS} --prepare 'rm -rf dist' 'npx vite build' --export-json /dev/stdout 2>/dev/null`,
          { cwd: rolldownDir, timeout: 600000 }
        );
        results.nextcompatRolldown.buildTime = parseHyperfine(rdJson);
      }
    } catch {
      // Fallback: manual timing
      console.log("  hyperfine failed, falling back to manual timing...");
      const buildTimes = { nextjs: [], nextcompat: [], rolldown: [] };

      for (let i = 0; i < RUNS; i++) {
        console.log(`  Run ${i + 1}/${RUNS}...`);

        exec("rm -rf .next", { cwd: nextjsDir });
        const njsStart = performance.now();
        exec("npx next build", { cwd: nextjsDir, timeout: 120000 });
        buildTimes.nextjs.push(performance.now() - njsStart);

        exec("rm -rf dist", { cwd: nextcompatDir });
        const ncStart = performance.now();
        exec("npx vite build", { cwd: nextcompatDir, timeout: 120000 });
        buildTimes.nextcompat.push(performance.now() - ncStart);

        if (hasRolldown) {
          exec("rm -rf dist", { cwd: rolldownDir });
          const rdStart = performance.now();
          exec("npx vite build", { cwd: rolldownDir, timeout: 120000 });
          buildTimes.rolldown.push(performance.now() - rdStart);
        }
      }

      const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const stddev = (arr) => {
        const m = avg(arr);
        return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
      };

      results.nextjs.buildTime = {
        mean: avg(buildTimes.nextjs),
        stddev: stddev(buildTimes.nextjs),
        min: Math.min(...buildTimes.nextjs),
        max: Math.max(...buildTimes.nextjs),
      };
      results.nextcompat.buildTime = {
        mean: avg(buildTimes.nextcompat),
        stddev: stddev(buildTimes.nextcompat),
        min: Math.min(...buildTimes.nextcompat),
        max: Math.max(...buildTimes.nextcompat),
      };
      if (hasRolldown && buildTimes.rolldown.length) {
        results.nextcompatRolldown.buildTime = {
          mean: avg(buildTimes.rolldown),
          stddev: stddev(buildTimes.rolldown),
          min: Math.min(...buildTimes.rolldown),
          max: Math.max(...buildTimes.rolldown),
        };
      }
    }

    // ─── 2. Bundle Size ────────────────────────────────────────────────────────
    console.log("\n=== Production Bundle Size ===\n");

    // Rebuild both to get fresh output
    exec("rm -rf .next", { cwd: nextjsDir });
    exec("npx next build", { cwd: nextjsDir, timeout: 120000 });

    exec("rm -rf dist", { cwd: nextcompatDir });
    exec("npx vite build", { cwd: nextcompatDir, timeout: 120000 });

    // Next.js: client bundles are in .next/static
    const njsSize = bundleSize(join(nextjsDir, ".next", "static"));
    results.nextjs.bundleSize = njsSize;
    console.log(`  Next.js:     ${njsSize.files} files, ${formatBytes(njsSize.raw)} raw, ${formatBytes(njsSize.gzip)} gzip`);

    // nextcompat (Rollup): client bundles are in dist/client
    const ncSize = bundleSize(join(nextcompatDir, "dist", "client"));
    results.nextcompat.bundleSize = ncSize;
    console.log(`  nextcompat (Rollup):    ${ncSize.files} files, ${formatBytes(ncSize.raw)} raw, ${formatBytes(ncSize.gzip)} gzip`);

    // nextcompat (Rolldown): client bundles are in dist/client
    if (hasRolldown) {
      exec("rm -rf dist", { cwd: rolldownDir });
      exec("npx vite build", { cwd: rolldownDir, timeout: 120000 });
      const rdSize = bundleSize(join(rolldownDir, "dist", "client"));
      results.nextcompatRolldown.bundleSize = rdSize;
      console.log(`  nextcompat (Rolldown):  ${rdSize.files} files, ${formatBytes(rdSize.raw)} raw, ${formatBytes(rdSize.gzip)} gzip`);
    }
  }

  // ─── 3. Dev Server Cold Start ──────────────────────────────────────────────
  if (!SKIP_DEV) {
    console.log("\n=== Dev Server Cold Start ===\n");

    const devResults = { nextjs: [], nextcompat: [], rolldown: [] };

    for (let i = 0; i < RUNS; i++) {
      console.log(`  Run ${i + 1}/${RUNS}...`);

      // Next.js dev
      console.log("    Starting Next.js dev server...");
      exec("rm -rf .next", { cwd: nextjsDir });
      const njsDev = await startAndMeasure("npx", ["next", "dev", "--turbopack", "-p", "4100"], nextjsDir, "http://localhost:4100");
      devResults.nextjs.push({ coldStartMs: njsDev.coldStartMs, peakRssKb: njsDev.peakRssKb });
      console.log(`    Next.js: ${formatMs(njsDev.coldStartMs)}, ${Math.round(njsDev.peakRssKb / 1024)} MB RSS`);
      kill(njsDev.process);
      await new Promise((r) => setTimeout(r, 2000)); // cooldown

      // nextcompat (Rollup) dev
      console.log("    Starting nextcompat (Rollup) dev server...");
      const ncDev = await startAndMeasure("npx", ["vite", "--port", "4101"], nextcompatDir, "http://localhost:4101");
      devResults.nextcompat.push({ coldStartMs: ncDev.coldStartMs, peakRssKb: ncDev.peakRssKb });
      console.log(`    nextcompat (Rollup): ${formatMs(ncDev.coldStartMs)}, ${Math.round(ncDev.peakRssKb / 1024)} MB RSS`);
      kill(ncDev.process);
      await new Promise((r) => setTimeout(r, 2000)); // cooldown

      // nextcompat (Rolldown) dev
      if (hasRolldown) {
        console.log("    Starting nextcompat (Rolldown) dev server...");
        const rdDev = await startAndMeasure("npx", ["vite", "--port", "4102"], rolldownDir, "http://localhost:4102");
        devResults.rolldown.push({ coldStartMs: rdDev.coldStartMs, peakRssKb: rdDev.peakRssKb });
        console.log(`    nextcompat (Rolldown): ${formatMs(rdDev.coldStartMs)}, ${Math.round(rdDev.peakRssKb / 1024)} MB RSS`);
        kill(rdDev.process);
        await new Promise((r) => setTimeout(r, 2000)); // cooldown
      }
    }

    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

    results.nextjs.devColdStart = {
      meanMs: avg(devResults.nextjs.map((r) => r.coldStartMs)),
      meanRssKb: avg(devResults.nextjs.map((r) => r.peakRssKb)),
      runs: devResults.nextjs,
    };
    results.nextcompat.devColdStart = {
      meanMs: avg(devResults.nextcompat.map((r) => r.coldStartMs)),
      meanRssKb: avg(devResults.nextcompat.map((r) => r.peakRssKb)),
      runs: devResults.nextcompat,
    };
    if (hasRolldown && devResults.rolldown.length) {
      results.nextcompatRolldown.devColdStart = {
        meanMs: avg(devResults.rolldown.map((r) => r.coldStartMs)),
        meanRssKb: avg(devResults.rolldown.map((r) => r.peakRssKb)),
        runs: devResults.rolldown,
      };
    }
  }

  // ─── 4. SSR Throughput & TTFB ──────────────────────────────────────────────
  // TODO: Requires wiring up nextcompat production server (startProdServer)
  // to serve dynamic SSR pages, not just static preview. Skipped for now.
  if (!SKIP_SSR) {
    console.log("\n=== SSR Throughput & TTFB ===\n");
    console.log("  Skipped — nextcompat production server not yet wired for benchmark app.");
    console.log("  Next.js `next start` does SSR; nextcompat `vite preview` only serves static.");
    console.log("  This will be added once the prod server integration is complete.\n");
  }

  // ─── Output Results ────────────────────────────────────────────────────────
  console.log("\n=== Results ===\n");

  // Save JSON
  const jsonFile = join(RESULTS_DIR, `bench-${results.gitHash}-${Date.now()}.json`);
  writeFileSync(jsonFile, JSON.stringify(results, null, 2));
  console.log(`  JSON: ${jsonFile}\n`);

  // Generate markdown summary
  let md = `# Benchmark Results\n\n`;
  md += `- **Date**: ${results.timestamp}\n`;
  md += `- **Git**: ${results.gitHash}\n`;
  md += `- **Node**: ${results.system.nodeVersion}\n`;
  md += `- **CPUs**: ${results.system.cpus}\n`;
  md += `- **Runs**: ${results.runs}\n\n`;

  const hasRolldownResults = results.nextcompatRolldown && Object.keys(results.nextcompatRolldown).length > 0;

  if (results.nextjs.buildTime && results.nextcompat.buildTime) {
    md += `## Production Build Time\n\n`;
    md += `| Framework | Mean | StdDev | Min | Max | vs Next.js |\n`;
    md += `|-----------|------|--------|-----|-----|------------|\n`;
    md += `| Next.js 16 (Turbopack) | ${formatMs(results.nextjs.buildTime.mean)} | ±${formatMs(results.nextjs.buildTime.stddev)} | ${formatMs(results.nextjs.buildTime.min)} | ${formatMs(results.nextjs.buildTime.max)} | baseline |\n`;

    const rollupRatio = results.nextjs.buildTime.mean / results.nextcompat.buildTime.mean;
    md += `| nextcompat (Vite 7 / Rollup) | ${formatMs(results.nextcompat.buildTime.mean)} | ±${formatMs(results.nextcompat.buildTime.stddev)} | ${formatMs(results.nextcompat.buildTime.min)} | ${formatMs(results.nextcompat.buildTime.max)} | **${rollupRatio.toFixed(1)}x faster** |\n`;

    if (hasRolldownResults && results.nextcompatRolldown.buildTime) {
      const rolldownRatio = results.nextjs.buildTime.mean / results.nextcompatRolldown.buildTime.mean;
      md += `| nextcompat (Vite 8 / Rolldown) | ${formatMs(results.nextcompatRolldown.buildTime.mean)} | ±${formatMs(results.nextcompatRolldown.buildTime.stddev)} | ${formatMs(results.nextcompatRolldown.buildTime.min)} | ${formatMs(results.nextcompatRolldown.buildTime.max)} | **${rolldownRatio.toFixed(1)}x faster** |\n`;
    }
    md += "\n";
  }

  if (results.nextjs.bundleSize && results.nextcompat.bundleSize) {
    md += `## Production Bundle Size (Client)\n\n`;
    md += `| Framework | Files | Raw | Gzipped | vs Next.js (gzip) |\n`;
    md += `|-----------|-------|-----|----------|--------------------|\n`;
    md += `| Next.js 16 | ${results.nextjs.bundleSize.files} | ${formatBytes(results.nextjs.bundleSize.raw)} | ${formatBytes(results.nextjs.bundleSize.gzip)} | baseline |\n`;

    const rollupSizePct = ((1 - results.nextcompat.bundleSize.gzip / results.nextjs.bundleSize.gzip) * 100).toFixed(0);
    md += `| nextcompat (Rollup) | ${results.nextcompat.bundleSize.files} | ${formatBytes(results.nextcompat.bundleSize.raw)} | ${formatBytes(results.nextcompat.bundleSize.gzip)} | **${rollupSizePct}% smaller** |\n`;

    if (hasRolldownResults && results.nextcompatRolldown.bundleSize) {
      const rolldownSizePct = ((1 - results.nextcompatRolldown.bundleSize.gzip / results.nextjs.bundleSize.gzip) * 100).toFixed(0);
      md += `| nextcompat (Rolldown) | ${results.nextcompatRolldown.bundleSize.files} | ${formatBytes(results.nextcompatRolldown.bundleSize.raw)} | ${formatBytes(results.nextcompatRolldown.bundleSize.gzip)} | **${rolldownSizePct}% smaller** |\n`;
    }
    md += "\n";
  }

  if (results.nextjs.devColdStart && results.nextcompat.devColdStart) {
    md += `## Dev Server Cold Start\n\n`;
    md += `| Framework | Mean Cold Start | Mean Peak RSS | vs Next.js |\n`;
    md += `|-----------|----------------|----------------|------------|\n`;
    md += `| Next.js 16 (Turbopack) | ${formatMs(results.nextjs.devColdStart.meanMs)} | ${Math.round(results.nextjs.devColdStart.meanRssKb / 1024)} MB | baseline |\n`;

    const rollupDevRatio = results.nextjs.devColdStart.meanMs / results.nextcompat.devColdStart.meanMs;
    md += `| nextcompat (Vite 7 / Rollup) | ${formatMs(results.nextcompat.devColdStart.meanMs)} | ${Math.round(results.nextcompat.devColdStart.meanRssKb / 1024)} MB | **${rollupDevRatio.toFixed(1)}x faster** |\n`;

    if (hasRolldownResults && results.nextcompatRolldown.devColdStart) {
      const rolldownDevRatio = results.nextjs.devColdStart.meanMs / results.nextcompatRolldown.devColdStart.meanMs;
      md += `| nextcompat (Vite 8 / Rolldown) | ${formatMs(results.nextcompatRolldown.devColdStart.meanMs)} | ${Math.round(results.nextcompatRolldown.devColdStart.meanRssKb / 1024)} MB | **${rolldownDevRatio.toFixed(1)}x faster** |\n`;
    }
    md += "\n";
  }

  // SSR throughput section will be added once prod server is wired up

  const mdFile = join(RESULTS_DIR, `bench-${results.gitHash}-${Date.now()}.md`);
  writeFileSync(mdFile, md);
  console.log(`  Markdown: ${mdFile}\n`);
  console.log(md);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
