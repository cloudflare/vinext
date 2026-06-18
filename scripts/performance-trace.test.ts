import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { filteredTraceGraph, type TraceNode } from "../apps/web/app/benchmarks/components/trace";

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("performance traces", () => {
  test("normalization retains every wide and deep profile frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vinext-performance-trace-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "samples.jsonl");
    const outputPath = join(directory, "results.json");
    const profilesDirectory = join(directory, "profiles");
    const benchmarkId = "dev-start:vinext";
    const profileDirectory = join(profilesDirectory, benchmarkId);
    await mkdir(profileDirectory, { recursive: true });

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

    await execFileAsync(process.execPath, [
      resolve("benchmarks/perf/normalize-results.mjs"),
      inputPath,
      outputPath,
      profilesDirectory,
    ]);

    const result = JSON.parse(await readFile(outputPath, "utf8"));
    const graph = result.benchmarks[0].flameGraph as TraceNode;
    expect(flatten(graph).filter((node) => node.name.startsWith("frame-"))).toHaveLength(91);
    expect(maxDepth(graph)).toBe(42);
    expect(graph).not.toHaveProperty("vinextFocus");
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
});

function flatten(root: TraceNode): TraceNode[] {
  return [root, ...(root.children ?? []).flatMap(flatten)];
}

function maxDepth(root: TraceNode): number {
  return root.children?.length ? 1 + Math.max(...root.children.map(maxDepth)) : 0;
}
