#!/usr/bin/env node

/**
 * Traffic simulator — generates realistic Zipf-distributed HTTP traffic
 * against a running vinext app. This populates Cloudflare zone analytics
 * so that `vinext deploy` with TPR can use real traffic data.
 *
 * Usage:
 *   node scripts/simulate-traffic.mjs                          # defaults
 *   node scripts/simulate-traffic.mjs --url https://my-app.com # custom target
 *   node scripts/simulate-traffic.mjs --total 50000            # more requests
 *   node scripts/simulate-traffic.mjs --concurrency 20         # faster
 *   node scripts/simulate-traffic.mjs --dry-run                # preview only
 */

// ─── CLI args ────────────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1];
  return fallback;
}

const BASE_URL = getFlag("url", "http://localhost:3000");
const TOTAL_REQUESTS = parseInt(getFlag("total", "10000"), 10);
const CONCURRENCY = parseInt(getFlag("concurrency", "10"), 10);
const NUM_PRODUCTS = 500;
const DRY_RUN = args.includes("--dry-run");

// ─── Zipf distribution ──────────────────────────────────────

/**
 * Generate a Zipf-distributed random page rank.
 * Uses inverse transform sampling with exponent 0.8.
 */
function zipfRank(numPages) {
  // Compute harmonic numbers for the CDF
  // (cached on first call)
  if (!zipfRank._cdf) {
    const cdf = [];
    let sum = 0;
    for (let i = 1; i <= numPages + 10; i++) {
      sum += 1 / Math.pow(i, 0.8);
      cdf.push(sum);
    }
    // Normalize
    zipfRank._cdf = cdf.map((v) => v / sum);
  }

  const r = Math.random();
  const cdf = zipfRank._cdf;
  for (let i = 0; i < cdf.length; i++) {
    if (r <= cdf[i]) return i + 1;
  }
  return cdf.length;
}

// ─── Route generation ────────────────────────────────────────

const STATIC_ROUTES = ["/", "/about", "/pricing", "/contact"];
const STATIC_WEIGHTS = [0.15, 0.02, 0.03, 0.01]; // relative traffic share

function pickRoute() {
  // 21% chance of a static page (weighted)
  const staticRoll = Math.random();
  let cumulative = 0;
  for (let i = 0; i < STATIC_ROUTES.length; i++) {
    cumulative += STATIC_WEIGHTS[i];
    if (staticRoll < cumulative) return STATIC_ROUTES[i];
  }

  // 79% chance of a product page (Zipf-distributed)
  const rank = zipfRank(NUM_PRODUCTS);
  return `/products/${rank}`;
}

// ─── Traffic simulation ─────────────────────────────────────

async function sendRequest(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "tpr-traffic-sim/1.0" },
      redirect: "manual",
    });
    await response.text(); // consume body
    return response.status;
  } catch {
    return 0; // connection error
  }
}

async function run() {
  console.log(`\n  TPR Traffic Simulator\n`);
  console.log(`  Target:      ${BASE_URL}`);
  console.log(`  Requests:    ${TOTAL_REQUESTS.toLocaleString()}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Products:    ${NUM_PRODUCTS}`);

  // Preview the traffic distribution
  const preview = {};
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    const route = pickRoute();
    preview[route] = (preview[route] || 0) + 1;
  }

  const sorted = Object.entries(preview)
    .sort((a, b) => b[1] - a[1]);

  console.log(`\n  Traffic distribution (top 20):\n`);
  for (const [route, count] of sorted.slice(0, 20)) {
    const pct = ((count / TOTAL_REQUESTS) * 100).toFixed(1);
    const bar = "\u2588".repeat(Math.round(count / TOTAL_REQUESTS * 50));
    console.log(`  ${pct.padStart(5)}%  ${bar.padEnd(25)} ${route}`);
  }
  console.log(`  ...and ${sorted.length - 20} more routes\n`);

  // Coverage analysis
  const totalReqs = sorted.reduce((s, [, c]) => s + c, 0);
  let accumulated = 0;
  let pagesFor90 = 0;
  for (const [, count] of sorted) {
    accumulated += count;
    pagesFor90++;
    if (accumulated >= totalReqs * 0.9) break;
  }
  console.log(
    `  ${sorted.length} unique paths — ${pagesFor90} pages cover 90% of traffic\n`,
  );

  if (DRY_RUN) {
    console.log("  Dry run — no requests sent.\n");
    return;
  }

  // Send requests
  console.log("  Sending requests...\n");
  const startTime = Date.now();
  let completed = 0;
  let errors = 0;
  const statusCounts = {};

  // Reset Zipf CDF cache for actual requests
  zipfRank._cdf = null;

  const queue = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    const route = pickRoute();
    const url = `${BASE_URL}${route}`;

    const promise = sendRequest(url).then((status) => {
      completed++;
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      if (status === 0) errors++;

      if (completed % 500 === 0 || completed === TOTAL_REQUESTS) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rps = Math.round(completed / (Date.now() - startTime) * 1000);
        process.stdout.write(
          `\r  ${completed.toLocaleString()} / ${TOTAL_REQUESTS.toLocaleString()} (${rps} req/s, ${elapsed}s)`,
        );
      }
    });

    queue.push(promise);

    // Limit concurrency
    if (queue.length >= CONCURRENCY) {
      await Promise.race(queue);
      // Remove settled promises
      for (let j = queue.length - 1; j >= 0; j--) {
        const settled = await Promise.race([
          queue[j].then(() => true),
          Promise.resolve(false),
        ]);
        if (settled) queue.splice(j, 1);
      }
    }
  }

  await Promise.all(queue);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rps = Math.round(TOTAL_REQUESTS / ((Date.now() - startTime) / 1000));

  console.log(`\n\n  Done in ${elapsed}s (${rps} req/s)`);
  console.log(`  Status codes: ${JSON.stringify(statusCounts)}`);
  if (errors > 0) console.log(`  Errors: ${errors}`);
  console.log();
}

run().catch(console.error);
