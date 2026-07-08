import type { TraceNode } from "./trace";

type ProfileTable = {
  schema?: Record<string, number>;
  data?: unknown[][];
  [column: string]: unknown;
};

type ProfileThread = {
  name?: string;
  processName?: string;
  samples?: ProfileTable & { length?: number; weightType?: string };
  stackTable?: ProfileTable;
  frameTable?: ProfileTable;
  funcTable?: ProfileTable;
  stringArray?: unknown[];
};

type SamplyProfile = {
  meta?: { interval?: number; vinextBenchmarkRounds?: number };
  shared?: Pick<ProfileThread, "stackTable" | "frameTable" | "funcTable" | "stringArray">;
  threads?: ProfileThread[];
};

export async function readGzipProfile(response: Response): Promise<SamplyProfile> {
  if (!response.body) throw new Error("Profile response has no body");
  const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).json() as Promise<SamplyProfile>;
}

export async function readProfileFile(file: File): Promise<SamplyProfile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const response = new Response(bytes);
  if (gzipped) return readGzipProfile(response);
  return response.json() as Promise<SamplyProfile>;
}

type MutableTraceNode = Omit<TraceNode, "children"> & {
  children: Map<string, MutableTraceNode>;
};

function column(table: ProfileTable | undefined, name: string, row: number) {
  const direct = table?.[name];
  if (Array.isArray(direct)) return direct[row];
  const index = table?.schema?.[name];
  return index === undefined ? undefined : table?.data?.[row]?.[index];
}

function normalizeSource(source: string | null) {
  if (!source) return undefined;
  const withoutProtocol = source.replace(/^file:\/\//, "");
  const repositoryMarker = "/work/vinext/vinext/";
  const repositoryIndex = withoutProtocol.indexOf(repositoryMarker);
  if (repositoryIndex >= 0) {
    return withoutProtocol.slice(repositoryIndex + repositoryMarker.length);
  }
  const nodeModulesIndex = withoutProtocol.lastIndexOf("/node_modules/");
  if (nodeModulesIndex >= 0) return withoutProtocol.slice(nodeModulesIndex + 1);
  return withoutProtocol;
}

function isNodeModuleSource(source: string, packageName: string) {
  return (
    source.includes(`/node_modules/${packageName}/`) ||
    source.includes(`/node_modules/.pnpm/${packageName.replace("/", "+")}@`) ||
    source.includes(`/node_modules/.pnpm/${packageName.replace("/", "+")}_`)
  );
}

function frameCategory(rawSource: string | null, source?: string) {
  if (!rawSource && !source) return "native";
  const path = rawSource?.replace(/^file:\/\//, "") ?? source ?? "";
  if (
    path.includes("/packages/vinext/") ||
    isNodeModuleSource(path, "vinext") ||
    isNodeModuleSource(path, "@vinext/cloudflare") ||
    isNodeModuleSource(path, "@vinext/nitro")
  ) {
    return "vinext";
  }
  if (path.includes("/rolldown/") || path.includes("rolldown-")) return "rolldown";
  if (path.includes("vite-plus-core/dist/vite/") || isNodeModuleSource(path, "vite")) {
    return "vite";
  }
  if (path.startsWith("node:")) return "node";
  if (source?.startsWith("node_modules/")) return "dependency";
  if (source?.startsWith("benchmarks/")) return "benchmark";
  return "application";
}

function parseFrame(rawName: string) {
  const cleanedName = rawName.replace(/^JS:[+*'^~]*/, "");
  const sourceMatch = cleanedName.match(/\s((?:file:\/\/|node:)[^\s]+)$/);
  const rawSource = sourceMatch?.[1] ?? null;
  const source = normalizeSource(rawSource);
  const name = sourceMatch ? cleanedName.slice(0, sourceMatch.index).trim() : cleanedName;
  return { name: name || "(anonymous)", source, category: frameCategory(rawSource, source) };
}

function stackFrames(tables: ProfileThread, initialStackIndex: number) {
  const frames: ReturnType<typeof parseFrame>[] = [];
  const seen = new Set<number>();
  let stackIndex: unknown = initialStackIndex;
  while (typeof stackIndex === "number" && !seen.has(stackIndex)) {
    seen.add(stackIndex);
    const frameIndex = column(tables.stackTable, "frame", stackIndex);
    if (typeof frameIndex !== "number") break;
    const funcIndex = column(tables.frameTable, "func", frameIndex);
    const nameIndex =
      typeof funcIndex === "number" ? column(tables.funcTable, "name", funcIndex) : undefined;
    const fallbackNameIndex = column(tables.frameTable, "location", frameIndex);
    const stringIndex = typeof nameIndex === "number" ? nameIndex : fallbackNameIndex;
    const name = typeof stringIndex === "number" ? tables.stringArray?.[stringIndex] : undefined;
    if (typeof name === "string" && name.length > 0) frames.push(parseFrame(name));
    stackIndex = column(tables.stackTable, "prefix", stackIndex);
  }
  return frames.reverse();
}

function addStack(root: MutableTraceNode, frames: ReturnType<typeof parseFrame>[], weight: number) {
  root.value += weight;
  let current = root;
  for (const frame of frames) {
    const key = `${frame.category}\0${frame.name}\0${frame.source ?? ""}`;
    let child = current.children.get(key);
    if (!child) {
      child = { ...frame, value: 0, children: new Map() };
      current.children.set(key, child);
    }
    child.value += weight;
    current = child;
  }
}

function serializeTree(node: MutableTraceNode): TraceNode {
  const children = Array.from(node.children.values())
    .toSorted((left, right) => right.value - left.value)
    .map(serializeTree);
  return {
    name: node.name,
    value: node.value,
    ...(node.source ? { source: node.source } : {}),
    ...(node.category ? { category: node.category } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

export function profileToFlameGraph(profile: SamplyProfile, rounds = 1): TraceNode | null {
  const root: MutableTraceNode = { name: "all samples", value: 0, children: new Map() };
  const profileRounds = Number(profile.meta?.vinextBenchmarkRounds ?? rounds) || 1;
  const sampleIntervalMs = (Number(profile.meta?.interval ?? 1) || 1) / Math.max(profileRounds, 1);
  for (const thread of profile.threads ?? []) {
    const tables = profile.shared ? { ...thread, ...profile.shared } : thread;
    if (!tables.stackTable || !tables.frameTable || !tables.funcTable || !tables.stringArray) {
      continue;
    }
    const sampleLength = thread.samples?.length ?? thread.samples?.data?.length ?? 0;
    const usesSampleWeights = thread.samples?.weightType === "samples";
    for (let row = 0; row < sampleLength; row++) {
      const stackIndex = column(thread.samples, "stack", row);
      if (typeof stackIndex !== "number") continue;
      const rawWeight = Math.abs(Number(column(thread.samples, "weight", row) ?? 1)) || 1;
      const frames = stackFrames(tables, stackIndex);
      if (frames.length === 0) continue;
      addStack(
        root,
        [
          {
            name: thread.processName || thread.name || "unknown process",
            source: undefined,
            category: "process",
          },
          ...frames,
        ],
        (usesSampleWeights ? rawWeight : 1) * sampleIntervalMs,
      );
    }
  }
  return root.value === 0 ? null : serializeTree(root);
}
