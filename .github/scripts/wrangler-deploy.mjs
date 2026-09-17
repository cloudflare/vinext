import { spawnSync } from "node:child_process";

const maxAttempts = 12;

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const result = spawnSync("vp", ["exec", "wrangler", "deploy", ...process.argv.slice(2)], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.status === 0) process.exit(0);
  if (!`${result.stdout}${result.stderr}`.includes("[code: 10007]") || attempt === maxAttempts) {
    process.exit(result.status ?? 1);
  }

  console.log("Worker provisioning has not propagated; retrying in 10 seconds...");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
