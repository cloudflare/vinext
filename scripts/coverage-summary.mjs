#!/usr/bin/env node
// Renders coverage/coverage-summary.json as a GitHub-flavored markdown table
// for $GITHUB_STEP_SUMMARY. Stdout only; never throws on missing data so the
// CI step stays green when coverage is unavailable.
import { readFileSync, existsSync } from "node:fs";

const SUMMARY_PATH = "coverage/coverage-summary.json";

if (!existsSync(SUMMARY_PATH)) {
  console.log("> Coverage summary not found — skipping.");
  process.exit(0);
}

const data = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));
const total = data.total;

const fmt = (m) => `${m.pct.toFixed(2)}% (${m.covered}/${m.total})`;

const rows = [
  ["Lines", fmt(total.lines)],
  ["Statements", fmt(total.statements)],
  ["Functions", fmt(total.functions)],
  ["Branches", fmt(total.branches)],
];

console.log("## Integration test coverage");
console.log("");
console.log("| Metric | Coverage |");
console.log("| --- | --- |");
for (const [name, value] of rows) console.log(`| ${name} | ${value} |`);
console.log("");
console.log(
  `Scope: \`packages/vinext/src/**\` (excluding .d.ts/test files). ` +
    `Provider: istanbul. Full HTML report in the \`coverage-html\` artifact.`,
);
