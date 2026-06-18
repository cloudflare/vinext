#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const inputPath = resolve(process.argv[2] ?? "benchmarks/results/perf-results.json");
const uploadUrl =
  process.env.VINEXT_PERF_UPLOAD_URL ??
  "https://vinext-web.vinext.workers.dev/api/benchmarks/upload";
const secret = process.env.COMPAT_INGEST_SECRET;
const artifactRoot = process.env.VINEXT_PERF_ARTIFACT_ROOT
  ? resolve(process.env.VINEXT_PERF_ARTIFACT_ROOT)
  : null;

if (!secret) {
  console.log("COMPAT_INGEST_SECRET is not configured; skipping performance upload.");
  process.exit(0);
}

const payload = JSON.parse(await readFile(inputPath, "utf8"));
const profileUploadUrl = uploadUrl.replace(/\/upload$/, "/profile-upload");
const uploadedProfileKeys = [];
let metadataCommitted = false;

function resolveProfilePath(profileFile) {
  if (!artifactRoot) {
    return isAbsolute(profileFile) ? profileFile : resolve(dirname(inputPath), profileFile);
  }
  if (isAbsolute(profileFile)) {
    throw new Error("Artifact profile paths must be relative");
  }
  const profilePath = resolve(artifactRoot, profileFile);
  const artifactRelativePath = relative(artifactRoot, profilePath);
  if (artifactRelativePath.startsWith("..") || isAbsolute(artifactRelativePath)) {
    throw new Error("Artifact profile path escapes the artifact directory");
  }
  return profilePath;
}

async function rollbackProfiles() {
  const failures = [];
  for (const key of uploadedProfileKeys.reverse()) {
    try {
      const response = await fetch(profileUploadUrl, {
        method: "DELETE",
        headers: {
          "X-Compat-Secret": secret,
          "X-Performance-Profile-Key": key,
        },
      });
      if (!response.ok) failures.push(`${key}: ${response.status} ${await response.text()}`);
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) console.error(`Failed to roll back profiles:\n${failures.join("\n")}`);
}

try {
  for (const benchmark of payload.benchmarks) {
    if (!benchmark.profileFile) continue;
    const profilePath = resolveProfilePath(benchmark.profileFile);
    const contents = await readFile(profilePath);
    const response = await fetch(profileUploadUrl, {
      method: "PUT",
      headers: {
        "X-Compat-Secret": secret,
        "Content-Type": "application/gzip",
        "X-Performance-Run-Kind": payload.run.kind,
        "X-Performance-Commit-Sha": payload.run.commitSha,
        "X-Performance-Execution-Id": payload.run.executionId,
        "X-Performance-Benchmark-Id": benchmark.benchmarkId,
      },
      body: contents,
    });
    if (!response.ok) {
      throw new Error(
        `Performance profile upload failed (${response.status}): ${await response.text()}`,
      );
    }
    const uploaded = await response.json();
    uploadedProfileKeys.push(uploaded.key);
    benchmark.profileObjectKey = uploaded.key;
    delete benchmark.profileFile;
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Compat-Secret": secret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Performance upload failed (${response.status}): ${await response.text()}`);
  }
  metadataCommitted = true;

  const responseBody = await response.text();
  if (process.env.VINEXT_PERF_UPLOAD_RESPONSE_PATH) {
    await writeFile(resolve(process.env.VINEXT_PERF_UPLOAD_RESPONSE_PATH), `${responseBody}\n`);
  }
  console.log(responseBody);
} catch (error) {
  if (!metadataCommitted) await rollbackProfiles();
  throw error;
}
