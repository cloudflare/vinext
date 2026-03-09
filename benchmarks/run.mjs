#!/usr/bin/env node
/**
 * Benchmark harness: compares Next.js 16 (Turbopack) vs vinext (Vite 7/Rollup) vs vinext (Vite 8/Rolldown)
 *
 * Metrics:
 *   1. Production build time (hyperfine)
 *   2. Production bundle size (total JS+CSS, gzipped)
 *   3. Dev server cold start (time to first successful HTTP 200)
 *   4. SSR throughput & TTFB (autocannon against production server)
 *   5. Memory usage (peak RSS during build and dev)
 *
 * Prerequisites: hyperfine, autocannon (npm i -g autocannon)
 * Usage: node benchmarks/run.mjs [--runs N] [--dev-runs N] [--skip-build] [--skip-dev] [--skip-ssr] [--skip-rolldown]
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

// Disable Next.js telemetry to avoid non-deterministic network latency in benchmarks.
process.env.NEXT_TELEMETRY_DISABLED = "1";

// ─── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const RUNS = parseInt(args.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? "5", 10);
const DEV_RUNS = parseInt(args.find((a) => a.startsWith("--dev-runs="))?.split("=")[1] ?? "10", 10);
const SKIP_BUILD = args.includes("--skip-build");
const SKIP_DEV = args.includes("--skip-dev");
const SKIP_SSR = args.includes("--skip-ssr");
const SKIP_ROLLDOWN = args.includes("--skip-rolldown");

// ─── Helpers ───────────────────────────────────────────────────────────────────
function exec(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts });
}

function getGitHash() {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      cwd: join(__dirname, ".."),
    }).trim();
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
 * Sum RSS (in KB) for an entire process group.
 * The process was spawned with detached:true so proc.pid is the PGID.
 * On Linux, `pgrep -g` enumerates PIDs in the process group reliably.
 * On macOS, `pgrep -g` matches by GID (not PGID), so instead we list all
 * processes with `ps -axo pid=,pgid=,rss=` and sum RSS for rows whose PGID
 * matches the leader PID.
 */
function getGroupRssKb(pid) {
  try {
    let out;
    if (process.platform === "linux") {
      const pidsRaw = execSync(`pgrep -g ${pid}`, { encoding: "utf-8" }).trim();
      if (!pidsRaw) return 0;
      const pidList = pidsRaw.split("\n").join(",");
      out = execSync(`ps -o rss= -p ${pidList}`, { encoding: "utf-8" });
      return out
        .trim()
        .split("\n")
        .reduce((sum, line) => sum + (parseInt(line.trim(), 10) || 0), 0);
    } else {
      // macOS: enumerate all processes and sum RSS for those in our PGID
      out = execSync(`ps -axo pid=,pgid=,rss=`, { encoding: "utf-8" });
      const pgid = String(pid);
      return out
        .trim()
        .split("\n")
        .reduce((sum, line) => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3 && parts[1] === pgid) {
            return sum + (parseInt(parts[2], 10) || 0);
          }
          return sum;
        }, 0);
    }
  } catch {
    return 0;
  }
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
    detached: true, // Own process group so we can kill the tree safely
    env: { ...process.env, PORT: new URL(url).port },
  });

  // Collect stderr/stdout for debugging
  let output = "";
  proc.stdout?.on("data", (d) => (output += d.toString()));
  proc.stderr?.on("data", (d) => (output += d.toString()));

  // Poll RSS every 200ms (sum across process group on Linux)
  const rssInterval = setInterval(() => {
    const rss = getGroupRssKb(proc.pid);
    if (rss > peakRssKb) peakRssKb = rss;
  }, 200);

  try {
    const coldStartMs = await waitForServer(url, 60000);
    clearInterval(rssInterval);

    // Final RSS
    const rss = getGroupRssKb(proc.pid);
    if (rss > peakRssKb) peakRssKb = rss;

    return { coldStartMs, peakRssKb, process: proc, output };
  } catch (err) {
    clearInterval(rssInterval);
    kill(proc);
    console.error("Server output:", output);
    throw err;
  }
}

function kill(proc) {
  if (!proc || proc.killed) return;
  // The process was spawned with detached:true so it has its own process group.
  // Kill the entire group with -PID (negative) which is safe because it won't
  // include our own script.
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {}
}

// Fisher-Yates shuffle — used to randomize runner order and eliminate positional bias.
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
    buildRuns: RUNS,
    devRuns: DEV_RUNS,
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpus: (await import("node:os")).cpus().length,
    },
    nextjs: {},
    vinext: {},
    vinextRolldown: {},
  };

  const nextjsDir = join(__dirname, "nextjs");
  const vinextDir = join(__dirname, "vinext");
  const vinextRolldownDir = join(__dirname, "vinext-rolldown");
  const hasRolldown = !SKIP_ROLLDOWN && existsSync(join(vinextRolldownDir, "package.json"));

  // Detect actual installed versions for reproducibility
  try {
    const njsPkg = JSON.parse(
      readFileSync(join(nextjsDir, "node_modules", "next", "package.json"), "utf-8"),
    );
    results.system.nextjsVersion = njsPkg.version;
  } catch {
    /* deps not installed yet */
  }
  try {
    const vitePkg = JSON.parse(
      readFileSync(join(vinextDir, "node_modules", "vite", "package.json"), "utf-8"),
    );
    results.system.viteVersion = vitePkg.version;
  } catch {
    /* deps not installed yet */
  }
  if (hasRolldown) {
    try {
      const rdPkg = JSON.parse(
        readFileSync(join(vinextRolldownDir, "node_modules", "vite", "package.json"), "utf-8"),
      );
      results.system.viteRolldownVersion = rdPkg.version;
    } catch {
      /* deps not installed yet */
    }
  }

  // ─── 1. Production Build Time ──────────────────────────────────────────────
  if (!SKIP_BUILD) {
    console.log("\n=== Production Build Time ===\n");

    // Clean previous builds
    exec("rm -rf .next", { cwd: nextjsDir });
    exec("rm -rf dist", { cwd: vinextDir });
    if (hasRolldown) exec("rm -rf dist", { cwd: vinextRolldownDir });

    // Ensure plugin is built
    console.log("  Building vinext plugin...");
    exec("./node_modules/.bin/tsc -p packages/vinext/tsconfig.json", {
      cwd: join(__dirname, ".."),
    });

    // Warmup run for all (not measured)
    console.log("  Warmup: Next.js build...");
    exec("./node_modules/.bin/next build --turbopack", { cwd: nextjsDir, timeout: 120000 });
    exec("rm -rf .next", { cwd: nextjsDir });

    console.log("  Warmup: vinext (Rollup) build...");
    exec("./node_modules/.bin/vite build", { cwd: vinextDir, timeout: 120000 });
    exec("rm -rf dist", { cwd: vinextDir });

    if (hasRolldown) {
      console.log("  Warmup: vinext (Rolldown) build...");
      exec("./node_modules/.bin/vite build", { cwd: vinextRolldownDir, timeout: 120000 });
      exec("rm -rf dist", { cwd: vinextRolldownDir });
    }

    // Measured runs with hyperfine (single invocation with --shuffle for fair ordering)
    console.log(`\n  Running ${RUNS} build iterations with hyperfine (randomized order)...\n`);

    function parseHyperfineResult(r) {
      return {
        mean: r.mean * 1000,
        stddev: r.stddev * 1000,
        min: r.min * 1000,
        max: r.max * 1000,
      };
    }

    try {
      // Build a single hyperfine command with all projects and --shuffle so
      // runs are interleaved randomly, eliminating positional bias from
      // warmed filesystem caches, CPU thermal state, or residual process state.
      const cmds = [
        `--command-name nextjs 'rm -rf ${nextjsDir}/.next && ./node_modules/.bin/next build --turbopack'`,
        `--command-name vinext 'rm -rf ${vinextDir}/dist && ./node_modules/.bin/vite build --root ${vinextDir}'`,
      ];
      if (hasRolldown) {
        cmds.push(
          `--command-name rolldown 'rm -rf ${vinextRolldownDir}/dist && ./node_modules/.bin/vite build --root ${vinextRolldownDir}'`,
        );
      }

      console.log("  Timing all builds (shuffled)...");
      const hfJson = exec(
        `hyperfine --runs ${RUNS} --shuffle ${cmds.join(" ")} --export-json /dev/stdout 2>/dev/null`,
        { cwd: __dirname, timeout: 600000 },
      );
      const hf = JSON.parse(hfJson);

      // Map results by command name
      for (const r of hf.results) {
        if (r.command.includes("next build")) {
          results.nextjs.buildTime = parseHyperfineResult(r);
        } else if (r.command.includes(vinextDir)) {
          results.vinext.buildTime = parseHyperfineResult(r);
        } else if (hasRolldown && r.command.includes(vinextRolldownDir)) {
          results.vinextRolldown.buildTime = parseHyperfineResult(r);
        }
      }
      results.buildMethodology = "hyperfine --shuffle (randomized)";
    } catch {
      // Fallback: manual timing with randomized runner order to eliminate positional bias
      console.log("  hyperfine failed, falling back to manual timing...");
      const buildTimes = { nextjs: [], vinext: [], rolldown: [] };

      const buildRunners = [
        {
          key: "nextjs",
          run: () => {
            exec("rm -rf .next", { cwd: nextjsDir });
            const start = performance.now();
            exec("./node_modules/.bin/next build --turbopack", { cwd: nextjsDir, timeout: 120000 });
            buildTimes.nextjs.push(performance.now() - start);
          },
        },
        {
          key: "vinext",
          run: () => {
            exec("rm -rf dist", { cwd: vinextDir });
            const start = performance.now();
            exec("./node_modules/.bin/vite build", { cwd: vinextDir, timeout: 120000 });
            buildTimes.vinext.push(performance.now() - start);
          },
        },
        ...(hasRolldown
          ? [
              {
                key: "rolldown",
                run: () => {
                  exec("rm -rf dist", { cwd: vinextRolldownDir });
                  const start = performance.now();
                  exec("./node_modules/.bin/vite build", {
                    cwd: vinextRolldownDir,
                    timeout: 120000,
                  });
                  buildTimes.rolldown.push(performance.now() - start);
                },
              },
            ]
          : []),
      ];

      const buildRunOrders = [];
      for (let i = 0; i < RUNS; i++) {
        const order = shuffle(buildRunners);
        buildRunOrders.push(order.map((r) => r.key));
        console.log(`  Run ${i + 1}/${RUNS} (order: ${order.map((r) => r.key).join(" → ")})...`);
        for (const runner of order) runner.run();
      }

      const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const stddev = (arr) => {
        if (arr.length < 2) return 0;
        const m = avg(arr);
        return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
      };

      results.nextjs.buildTime = {
        mean: avg(buildTimes.nextjs),
        stddev: stddev(buildTimes.nextjs),
        min: Math.min(...buildTimes.nextjs),
        max: Math.max(...buildTimes.nextjs),
      };
      results.vinext.buildTime = {
        mean: avg(buildTimes.vinext),
        stddev: stddev(buildTimes.vinext),
        min: Math.min(...buildTimes.vinext),
        max: Math.max(...buildTimes.vinext),
      };
      if (hasRolldown && buildTimes.rolldown.length) {
        results.vinextRolldown.buildTime = {
          mean: avg(buildTimes.rolldown),
          stddev: stddev(buildTimes.rolldown),
          min: Math.min(...buildTimes.rolldown),
          max: Math.max(...buildTimes.rolldown),
        };
      }
      results.buildMethodology = "manual timing (randomized)";
      results.buildRunOrders = buildRunOrders;
    }

    // ─── 2. Bundle Size ────────────────────────────────────────────────────────
    // Measures client-side JS/CSS/MJS files only. Both directories (.next/static
    // and dist/client) contain only browser assets, not server bundles.
    // TODO: If the benchmark app ever uses CSS Modules or global CSS imports,
    // verify that both frameworks extract CSS to the measured directories.
    // Currently the app uses inline styles so CSS extraction is not a factor.
    console.log("\n=== Production Bundle Size ===\n");

    // Rebuild both to get fresh output
    exec("rm -rf .next", { cwd: nextjsDir });
    exec("./node_modules/.bin/next build --turbopack", { cwd: nextjsDir, timeout: 120000 });

    exec("rm -rf dist", { cwd: vinextDir });
    exec("./node_modules/.bin/vite build", { cwd: vinextDir, timeout: 120000 });

    // Next.js: client bundles are in .next/static
    const njsSize = bundleSize(join(nextjsDir, ".next", "static"));
    results.nextjs.bundleSize = njsSize;
    console.log(
      `  Next.js:     ${njsSize.files} files, ${formatBytes(njsSize.raw)} raw, ${formatBytes(njsSize.gzip)} gzip`,
    );

    // vinext (Rollup): client bundles are in dist/client
    const ncSize = bundleSize(join(vinextDir, "dist", "client"));
    results.vinext.bundleSize = ncSize;
    console.log(
      `  vinext (Rollup):    ${ncSize.files} files, ${formatBytes(ncSize.raw)} raw, ${formatBytes(ncSize.gzip)} gzip`,
    );

    // vinext (Rolldown): client bundles are in dist/client
    if (hasRolldown) {
      exec("rm -rf dist", { cwd: vinextRolldownDir });
      exec("./node_modules/.bin/vite build", { cwd: vinextRolldownDir, timeout: 120000 });
      const rdSize = bundleSize(join(vinextRolldownDir, "dist", "client"));
      results.vinextRolldown.bundleSize = rdSize;
      console.log(
        `  vinext (Rolldown):  ${rdSize.files} files, ${formatBytes(rdSize.raw)} raw, ${formatBytes(rdSize.gzip)} gzip`,
      );
    }
  }

  // ─── 3. Dev Server Cold Start ──────────────────────────────────────────────
  if (!SKIP_DEV) {
    console.log("\n=== Dev Server Cold Start ===\n");

    const devResults = { nextjs: [], vinext: [], rolldown: [] };

    // Define the runners; order is randomized each iteration to eliminate
    // positional bias (first-after-kill penalties, OS cache warming, etc.)
    const runners = [
      {
        key: "nextjs",
        label: "Next.js",
        run: async () => {
          exec("rm -rf .next", { cwd: nextjsDir });
          return startAndMeasure(
            "./node_modules/.bin/next",
            ["dev", "--turbopack", "-p", "4100"],
            nextjsDir,
            "http://localhost:4100",
          );
        },
      },
      {
        key: "vinext",
        label: "vinext (Rollup)",
        run: async () => {
          exec("rm -rf node_modules/.vite", { cwd: vinextDir });
          return startAndMeasure(
            "./node_modules/.bin/vite",
            ["--port", "4101"],
            vinextDir,
            "http://localhost:4101",
          );
        },
      },
      ...(hasRolldown
        ? [
            {
              key: "rolldown",
              label: "vinext (Rolldown)",
              run: async () => {
                exec("rm -rf node_modules/.vite", { cwd: vinextRolldownDir });
                return startAndMeasure(
                  "./node_modules/.bin/vite",
                  ["--port", "4102"],
                  vinextRolldownDir,
                  "http://localhost:4102",
                );
              },
            },
          ]
        : []),
    ];

    const runOrders = [];

    for (let i = 0; i < DEV_RUNS; i++) {
      const order = shuffle(runners);
      const orderLabels = order.map((r) => r.label);
      runOrders.push(orderLabels);
      console.log(`  Run ${i + 1}/${DEV_RUNS} (order: ${orderLabels.join(" → ")})...`);

      for (const runner of order) {
        console.log(`    Starting ${runner.label} dev server...`);
        const result = await runner.run();
        devResults[runner.key].push({
          coldStartMs: result.coldStartMs,
          peakRssKb: result.peakRssKb,
        });
        console.log(
          `    ${runner.label}: ${formatMs(result.coldStartMs)}, ${Math.round(result.peakRssKb / 1024)} MB RSS`,
        );
        kill(result.process);
        await new Promise((r) => setTimeout(r, 2000)); // cooldown
      }
    }

    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

    results.nextjs.devColdStart = {
      meanMs: avg(devResults.nextjs.map((r) => r.coldStartMs)),
      meanRssKb: avg(devResults.nextjs.map((r) => r.peakRssKb)),
      runs: devResults.nextjs,
    };
    results.vinext.devColdStart = {
      meanMs: avg(devResults.vinext.map((r) => r.coldStartMs)),
      meanRssKb: avg(devResults.vinext.map((r) => r.peakRssKb)),
      runs: devResults.vinext,
    };
    if (hasRolldown && devResults.rolldown.length) {
      results.vinextRolldown.devColdStart = {
        meanMs: avg(devResults.rolldown.map((r) => r.coldStartMs)),
        meanRssKb: avg(devResults.rolldown.map((r) => r.peakRssKb)),
        runs: devResults.rolldown,
      };
    }
    results.devRunOrders = runOrders;
  }

  // ─── 4. SSR Throughput & TTFB ──────────────────────────────────────────────
  // TODO: Requires wiring up vinext production server (startProdServer)
  // to serve dynamic SSR pages, not just static preview. Skipped for now.
  if (!SKIP_SSR) {
    console.log("\n=== SSR Throughput & TTFB ===\n");
    console.log("  Skipped — vinext production server not yet wired for benchmark app.");
    console.log("  Next.js `next start` does SSR; vinext `vite preview` only serves static.");
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
  md += `- **Build runs**: ${results.buildRuns}\n`;
  md += `- **Dev cold start runs**: ${results.devRuns}\n`;
  if (results.system.nextjsVersion) md += `- **Next.js**: ${results.system.nextjsVersion}\n`;
  if (results.system.viteVersion) md += `- **Vite (Rollup)**: ${results.system.viteVersion}\n`;
  if (results.system.viteRolldownVersion)
    md += `- **Vite (Rolldown)**: ${results.system.viteRolldownVersion}\n`;
  md += "\n";
  md += `> **Note:** TypeScript type checking is disabled for the Next.js build (\`typescript.ignoreBuildErrors: true\`) so that build timings measure bundler/compilation speed only. Vite does not type-check during build.\n\n`;
  md += `> **Methodology:** Build and dev cold start runs are executed in randomized order to eliminate positional bias from filesystem caches, CPU thermal state, and residual process state.\n\n`;

  const hasRolldownResults =
    results.vinextRolldown && Object.keys(results.vinextRolldown).length > 0;

  // Format a speed ratio comparison: "2.1x faster" or "1.3x slower"
  function fmtSpeedup(baseline, value) {
    if (!baseline || !value) return "N/A";
    const ratio = baseline / value;
    if (ratio > 1) return `**${ratio.toFixed(1)}x faster**`;
    if (ratio < 1) return `**${(1 / ratio).toFixed(1)}x slower**`;
    return "same";
  }
  // Format a size reduction: "56% smaller" or "12% larger"
  function fmtSizeReduction(baseline, value) {
    if (!baseline || !value) return "N/A";
    const pct = Math.round((1 - value / baseline) * 100);
    if (pct > 0) return `**${pct}% smaller**`;
    if (pct < 0) return `**${Math.abs(pct)}% larger**`;
    return "same";
  }

  if (results.nextjs.buildTime && results.vinext.buildTime) {
    md += `## Production Build Time\n\n`;
    md += `| Framework | Mean | StdDev | Min | Max | vs Next.js |\n`;
    md += `|-----------|------|--------|-----|-----|------------|\n`;
    md += `| Next.js 16 (Turbopack) | ${formatMs(results.nextjs.buildTime.mean)} | ±${formatMs(results.nextjs.buildTime.stddev)} | ${formatMs(results.nextjs.buildTime.min)} | ${formatMs(results.nextjs.buildTime.max)} | baseline |\n`;
    md += `| vinext (Vite 7 / Rollup) | ${formatMs(results.vinext.buildTime.mean)} | ±${formatMs(results.vinext.buildTime.stddev)} | ${formatMs(results.vinext.buildTime.min)} | ${formatMs(results.vinext.buildTime.max)} | ${fmtSpeedup(results.nextjs.buildTime.mean, results.vinext.buildTime.mean)} |\n`;

    if (hasRolldownResults && results.vinextRolldown.buildTime) {
      md += `| vinext (Vite 8 / Rolldown) | ${formatMs(results.vinextRolldown.buildTime.mean)} | ±${formatMs(results.vinextRolldown.buildTime.stddev)} | ${formatMs(results.vinextRolldown.buildTime.min)} | ${formatMs(results.vinextRolldown.buildTime.max)} | ${fmtSpeedup(results.nextjs.buildTime.mean, results.vinextRolldown.buildTime.mean)} |\n`;
    }
    md += "\n";
  }

  if (results.nextjs.bundleSize && results.vinext.bundleSize) {
    md += `## Production Bundle Size (Client)\n\n`;
    md += `| Framework | Files | Raw | Gzipped | vs Next.js (gzip) |\n`;
    md += `|-----------|-------|-----|----------|--------------------|\n`;
    md += `| Next.js 16 | ${results.nextjs.bundleSize.files} | ${formatBytes(results.nextjs.bundleSize.raw)} | ${formatBytes(results.nextjs.bundleSize.gzip)} | baseline |\n`;
    md += `| vinext (Rollup) | ${results.vinext.bundleSize.files} | ${formatBytes(results.vinext.bundleSize.raw)} | ${formatBytes(results.vinext.bundleSize.gzip)} | ${fmtSizeReduction(results.nextjs.bundleSize.gzip, results.vinext.bundleSize.gzip)} |\n`;

    if (hasRolldownResults && results.vinextRolldown.bundleSize) {
      md += `| vinext (Rolldown) | ${results.vinextRolldown.bundleSize.files} | ${formatBytes(results.vinextRolldown.bundleSize.raw)} | ${formatBytes(results.vinextRolldown.bundleSize.gzip)} | ${fmtSizeReduction(results.nextjs.bundleSize.gzip, results.vinextRolldown.bundleSize.gzip)} |\n`;
    }
    md += "\n";
  }

  if (results.nextjs.devColdStart && results.vinext.devColdStart) {
    md += `## Dev Server Cold Start\n\n`;
    md += `| Framework | Mean Cold Start | Mean Peak RSS | vs Next.js |\n`;
    md += `|-----------|----------------|----------------|------------|\n`;
    md += `| Next.js 16 (Turbopack) | ${formatMs(results.nextjs.devColdStart.meanMs)} | ${Math.round(results.nextjs.devColdStart.meanRssKb / 1024)} MB | baseline |\n`;
    md += `| vinext (Vite 7 / Rollup) | ${formatMs(results.vinext.devColdStart.meanMs)} | ${Math.round(results.vinext.devColdStart.meanRssKb / 1024)} MB | ${fmtSpeedup(results.nextjs.devColdStart.meanMs, results.vinext.devColdStart.meanMs)} |\n`;

    if (hasRolldownResults && results.vinextRolldown.devColdStart) {
      md += `| vinext (Vite 8 / Rolldown) | ${formatMs(results.vinextRolldown.devColdStart.meanMs)} | ${Math.round(results.vinextRolldown.devColdStart.meanRssKb / 1024)} MB | ${fmtSpeedup(results.nextjs.devColdStart.meanMs, results.vinextRolldown.devColdStart.meanMs)} |\n`;
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
