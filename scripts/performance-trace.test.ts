import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { profileToFlameGraph } from "../apps/web/app/benchmarks/components/profile";
import { filteredTraceGraph, type TraceNode } from "../apps/web/app/benchmarks/components/trace";

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("performance traces", () => {
  test("normalization references the raw profile without embedding it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vinext-performance-trace-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "samples.jsonl");
    const outputPath = join(directory, "results.json");
    const profilesDirectory = join(directory, "profiles");
    const benchmarkId = "dev-start:vinext";
    const profileDirectory = join(profilesDirectory, benchmarkId);
    await mkdir(profileDirectory, { recursive: true });
    await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Performance Test"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "performance@example.com"], {
      cwd: directory,
    });
    await writeFile(join(directory, "commit.txt"), "measured commit\n");
    await execFileAsync("git", ["add", "commit.txt"], { cwd: directory });
    await execFileAsync("git", ["commit", "--quiet", "-m", "measured commit"], {
      cwd: directory,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2025-04-03T12:34:56+02:00",
        GIT_COMMITTER_DATE: "2025-04-03T12:34:56+02:00",
      },
    });
    const { stdout: commitShaOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
    });
    const commitSha = commitShaOutput.trim();

    const names = Array.from(
      { length: 91 },
      (_, index) =>
        `JS:frame-${index} file:///work/vinext/vinext/packages/vinext/src/frame-${index}.ts`,
    );
    const frames = names.map((_, index) => index);
    const prefixes: Array<number | null> = [];
    for (let index = 0; index < 41; index++) prefixes.push(index === 0 ? null : index - 1);
    for (let index = 41; index < names.length; index++) prefixes.push(null);
    const profile = {
      meta: { interval: 1 },
      threads: [
        {
          processName: "vinext",
          samples: {
            stack: [40, ...Array.from({ length: 50 }, (_, index) => index + 41)],
            weight: Array.from({ length: 51 }, () => 1),
            weightType: "samples",
            length: 51,
          },
          stackTable: { frame: frames, prefix: prefixes },
          frameTable: { func: frames },
          funcTable: { name: frames },
          stringArray: names,
        },
      ],
    };
    await writeFile(
      join(profileDirectory, "samply-profile.json.gz"),
      await gzipAsync(JSON.stringify(profile)),
    );
    await writeFile(
      inputPath,
      `${JSON.stringify({
        benchmarkId,
        scenarioId: "dev-start",
        suite: "Dev server",
        label: "Dev server cold start",
        description: "Starts the development server",
        implementationId: "vinext",
        implementationLabel: "vinext",
        unit: "ms",
        lowerIsBetter: true,
        value: 1,
        profile: true,
      })}\n`,
    );

    await execFileAsync(
      process.execPath,
      [resolve("benchmarks/perf/normalize-results.mjs"), inputPath, outputPath, profilesDirectory],
      {
        cwd: directory,
        env: { ...process.env, VINEXT_PERF_COMMIT_SHA: commitSha },
      },
    );

    const output = await readFile(outputPath, "utf8");
    const result = JSON.parse(output);
    expect(Buffer.byteLength(output)).toBeLessThan(10_000);
    expect(result.benchmarks[0].profileFile).toBe(join(profileDirectory, "samply-profile.json.gz"));
    expect(result.benchmarks[0]).not.toHaveProperty("flameGraph");
    expect(result.run.commitSha).toBe(commitSha);
    expect(result.run.measuredAt).toBe("2025-04-03T10:34:56.000Z");

    const graph = profileToFlameGraph(profile) as TraceNode;
    expect(flatten(graph).filter((node) => node.name.startsWith("frame-"))).toHaveLength(91);
    expect(maxDepth(graph)).toBe(42);
  });

  test("filters retain selected frames and recompute their sampled time", () => {
    const graph: TraceNode = {
      name: "all samples",
      value: 10,
      category: "process",
      children: [
        {
          name: "outer vinext",
          value: 10,
          category: "vinext",
          children: [
            {
              name: "node bridge",
              value: 8,
              category: "node",
              children: [{ name: "inner vinext", value: 5, category: "vinext" }],
            },
          ],
        },
      ],
    };

    expect(filteredTraceGraph(graph, new Set(["vinext"]))).toEqual({
      name: "filtered samples",
      value: 7,
      category: "process",
      children: [
        {
          name: "outer vinext",
          value: 7,
          category: "vinext",
          children: [{ name: "inner vinext", value: 5, category: "vinext" }],
        },
      ],
    });
    expect(filteredTraceGraph(graph, new Set(["vinext", "node"]))).toEqual({
      name: "filtered samples",
      value: 10,
      category: "process",
      children: graph.children,
    });
  });

  test("upload sends compact metadata and raw profiles as multipart files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vinext-performance-upload-"));
    temporaryDirectories.push(directory);
    const profilePath = join(directory, "samply-profile.json.gz");
    const resultsPath = join(directory, "perf-results.json");
    const profileContents = await gzipAsync(JSON.stringify({ threads: [] }));
    await writeFile(profilePath, profileContents);
    await writeFile(
      resultsPath,
      JSON.stringify({
        schemaVersion: 1,
        benchmarks: [
          { benchmarkId: "vinext-dev-cold-start-root", profileFile: profilePath },
          { benchmarkId: "nextjs-dev-cold-start-root", profileFile: null },
        ],
      }),
    );

    type ReceivedUpload = {
      secret: string | null;
      results: Record<string, unknown>;
      profile: File;
    };
    let resolveReceived: (upload: ReceivedUpload) => void;
    let rejectReceived: (error: unknown) => void;
    const received = new Promise<ReceivedUpload>((resolveUpload, rejectUpload) => {
      resolveReceived = resolveUpload;
      rejectReceived = rejectUpload;
    });
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const webRequest = new Request(`http://127.0.0.1${request.url}`, {
            method: request.method,
            headers: request.headers as HeadersInit,
            body: request as unknown as BodyInit,
            duplex: "half",
          } as unknown as RequestInit);
          const form = await webRequest.formData();
          const results = form.get("results");
          const profile = form.get("profile:vinext-dev-cold-start-root");
          if (typeof results !== "string" || !(profile instanceof File)) {
            throw new Error("Missing multipart fields");
          }
          const secretHeader = request.headers["x-compat-secret"];
          resolveReceived({
            secret: Array.isArray(secretHeader) ? secretHeader[0] : (secretHeader ?? null),
            results: JSON.parse(results),
            profile,
          });
          response.writeHead(201, { "Content-Type": "application/json" });
          response.end('{"ok":true}');
        } catch (error) {
          rejectReceived(error);
          response.writeHead(500);
          response.end();
        }
      })();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      await execFileAsync(
        process.execPath,
        [resolve("benchmarks/perf/upload-results.mjs"), resultsPath],
        {
          env: {
            ...process.env,
            COMPAT_INGEST_SECRET: "test-secret",
            VINEXT_PERF_UPLOAD_URL: `http://127.0.0.1:${address.port}/upload`,
          },
        },
      );
      const upload = await received;
      expect(upload.secret).toBe("test-secret");
      expect(upload.results).toMatchObject({
        benchmarks: [
          {
            benchmarkId: "vinext-dev-cold-start-root",
            profileFile: "samply-profile.json.gz",
          },
          { benchmarkId: "nextjs-dev-cold-start-root", profileFile: null },
        ],
      });
      expect(upload.profile.name).toBe("vinext-dev-cold-start-root.json.gz");
      expect(Buffer.from(await upload.profile.arrayBuffer())).toEqual(profileContents);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});

function flatten(root: TraceNode): TraceNode[] {
  return [root, ...(root.children ?? []).flatMap(flatten)];
}

function maxDepth(root: TraceNode): number {
  return root.children?.length ? 1 + Math.max(...root.children.map(maxDepth)) : 0;
}
