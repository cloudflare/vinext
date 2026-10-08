import { getCacheHandler, setCacheHandler, MemoryCacheHandler } from "vinext/shims/cache";
import { invokeCacheFunction } from "vinext/shims/cache-callable-runtime";
import { loadServerAction } from "@vitejs/plugin-rsc/react/rsc";
import { createElement } from "react";

let executions = 0;

async function describe(value: unknown): Promise<unknown> {
  if (value instanceof File) {
    return {
      name: value.name,
      lastModified: value.lastModified,
      type: value.type,
      size: value.size,
      text: await value.text(),
    };
  }
  if (value instanceof Blob) return { type: value.type, text: await value.text() };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return Promise.all([...value].map(describe));
  if (value instanceof Set) return Promise.all([...value].map(describe));
  if (value instanceof FormData) return Promise.all([...value].map(describe));
  if (ArrayBuffer.isView(value))
    return {
      type: value.constructor.name,
      offset: value.byteOffset,
      bytes: [...new Uint8Array(value.buffer)],
    };
  if (Array.isArray(value)) return Promise.all(value.map(describe));
  if (value && typeof value === "object") {
    if (
      "first" in value &&
      "second" in value &&
      value.first instanceof Date &&
      value.second instanceof Date
    ) {
      return { same: value.first === value.second, time: value.first.getTime() };
    }
    if ("then" in value) return describe(await value);
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, item]) => [key, await describe(item)]),
      ),
    );
  }
  return value;
}

async function inspect(input: unknown, _partition: string) {
  "use cache";
  return { execution: ++executions, value: await describe(input) };
}

async function inspectCaptured(input: unknown, partition: string) {
  async function captured() {
    "use cache";
    return { execution: ++executions, value: await describe(input), partition };
  }
  return captured();
}

async function inspectRichCaptures(input: unknown, partition: string) {
  const child = createElement("strong", null, "captured child");
  const token = Symbol.for("vinext:captured-token");
  async function captured() {
    "use cache";
    return { execution: ++executions, value: await describe(input), child, token, partition };
  }
  const result = await captured();
  return {
    execution: result.execution,
    value: { file: result.value, child: result.child.props.children, token: String(result.token) },
  };
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const text = query.get("text") ?? "";
  const kind = query.get("kind") ?? "file";
  const file = new File([text], query.get("name") ?? "private.txt", {
    lastModified: Number(query.get("time") ?? "111"),
    type: query.get("type") ?? "text/plain",
  });
  let input: unknown = file;
  if (kind === "nested") input = { files: [file] };
  if (kind === "promise") input = Promise.resolve(file);
  if (kind === "augmented-promise") input = Object.assign(Promise.resolve(file), { label: "same" });
  if (kind === "map-file") input = new Map([["file", file]]);
  if (kind === "set-file") input = new Set([file]);
  if (kind === "shared-file") input = { first: file, second: file };
  if (kind === "shared-blob") {
    const blob = new Blob([text], { type: file.type });
    input = { first: blob, second: blob };
  }
  if (kind === "form-file") {
    const form = new FormData();
    form.append("file", file);
    input = form;
  }
  if (kind === "blob") input = new Blob([text], { type: file.type });
  if (kind === "bytes") input = new TextEncoder().encode(text);
  if (kind === "byte-view" || kind === "data-view") {
    const bytes = new Uint8Array(query.get("standalone") === "1" ? [1] : [99, 1]);
    const offset = bytes.length - 1;
    input = kind === "byte-view" ? bytes.subarray(offset) : new DataView(bytes.buffer, offset);
  }
  if (kind === "nested-view") {
    const view = new Uint8Array([99, 1]).subarray(1);
    input = { view, nested: Promise.resolve(new Map([["view", view]])) };
  }
  if (kind === "array-iterator") {
    const values = [text];
    Object.defineProperty(values, Symbol.iterator, {
      value: function* () {
        yield "public";
      },
    });
    input = values;
  }
  if (kind === "date") input = new Date(text);
  if (kind === "invalid-date") input = new Date(NaN);
  if (kind === "shared-date") {
    const date = new Date(0);
    input = { first: date, second: date };
  }
  if (kind === "map") input = new Map([["text", text]]);
  if (kind === "set") input = new Set([text]);
  if (kind === "form-order") {
    const form = new FormData();
    for (const key of text) form.append(key, key);
    input = form;
  }
  const createPromiseInput = () =>
    ["a", "b"].map(
      (name, index) =>
        new Promise((resolve) => {
          const delay = query.get("order") === "reverse" ? 1 - index : index;
          setTimeout(
            () =>
              resolve({
                files: Promise.resolve(
                  new Map([[name, new File([name], name, { lastModified: 111 })]]),
                ),
              }),
            delay * 5,
          );
        }),
    );
  if (kind === "promise-order") input = createPromiseInput();
  const execute =
    kind === "captured-rich"
      ? inspectRichCaptures
      : kind === "captured-file"
        ? inspectCaptured
        : inspect;
  if (query.get("replay") === "1") {
    const previous = getCacheHandler();
    let forceMiss = false;
    const writes: Parameters<MemoryCacheHandler["set"]>[] = [];
    class RecordingCache extends MemoryCacheHandler {
      override async get(...args: Parameters<MemoryCacheHandler["get"]>) {
        return forceMiss ? null : super.get(...args);
      }
      override async set(...args: Parameters<MemoryCacheHandler["set"]>) {
        writes.push(args);
        return super.set(...args);
      }
    }
    setCacheHandler(new RecordingCache());
    try {
      const partition = query.get("partition") ?? "replay";
      const first = await execute(input, partition);
      const invocation = writes[0]?.[2]?.cacheFunctionInvocation;
      if (!invocation) return Response.json({ hasReplay: false });
      forceMiss = true;
      await invokeCacheFunction(invocation, loadServerAction);
      forceMiss = false;
      // A new request supplies fresh promises. Reusing the settled graph can
      // change Flight part ordering, as it does in Next.js.
      const after = await execute(
        kind === "promise-order" ? createPromiseInput() : input,
        partition,
      );
      return Response.json({
        hasReplay: true,
        first,
        after,
        sameKey: writes[0]?.[0] === writes[1]?.[0],
        writes: writes.length,
      });
    } finally {
      setCacheHandler(previous);
    }
  }
  return Response.json(await execute(input, query.get("partition") ?? "default"));
}
