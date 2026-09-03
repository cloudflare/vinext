import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  createWorkerdImportMetaUrlGuardPlugin,
  guardImportMetaUrlCalls,
  WORKERD_IMPORT_META_URL_FILTER,
} from "../packages/vinext/src/plugins/workerd-import-meta-url-guard.js";

describe("vinext:workerd-import-meta-url-guard", () => {
  it("does not apply to client environments", () => {
    const plugin = createWorkerdImportMetaUrlGuardPlugin();
    const applyToEnvironment = plugin.applyToEnvironment;
    expect(typeof applyToEnvironment).toBe("function");
    expect(
      (
        applyToEnvironment as (environment: {
          name: string;
          config: { consumer: string };
        }) => boolean
      )({ name: "client", config: { consumer: "client" } }),
    ).toBe(false);
  });

  it("guards fileURLToPath(import.meta.url)", () => {
    const code = `import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      'fileURLToPath(import.meta.url?.startsWith("file:") ? import.meta.url : "file:///")',
    );
  });

  it("guards createRequire(import.meta.url)", () => {
    const code = `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      'createRequire(import.meta.url?.startsWith("file:") ? import.meta.url : "file:///")',
    );
  });

  it.each(["fileURLToPath", "createRequire"])(
    "falls back when workerd exposes import.meta.url as worker for %s",
    (callee) => {
      const result = guardImportMetaUrlCalls(`const value = ${callee}(import.meta.url);`);
      expect(result).not.toBeNull();

      const executable = result!.code.replaceAll("import.meta.url", '"worker"');
      const helper = (value: string) => {
        if (value !== "file:///") throw new TypeError(`received ${value}`);
        return value;
      };

      expect(runInNewContext(`${executable}\nvalue`, { [callee]: helper })).toBe("file:///");
    },
  );

  it("preserves valid file URLs", () => {
    const result = guardImportMetaUrlCalls(`const value = fileURLToPath(import.meta.url);`);
    const executable = result!.code.replaceAll("import.meta.url", '"file:///app/index.js"');

    expect(
      runInNewContext(`${executable}\nvalue`, { fileURLToPath: (value: string) => value }),
    ).toBe("file:///app/index.js");
  });

  it("does not double-guard an already guarded call", () => {
    const code = `fileURLToPath(import.meta.url?.startsWith("file:") ? import.meta.url : "file:///")`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).toBeNull();
  });

  it("leaves non-call import.meta.url usage untouched", () => {
    const code = `const u = import.meta.url;
const res = new URL("./file.txt", import.meta.url);`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).toBeNull();
  });

  it("guards optional-chained import.meta?.url arguments", () => {
    const code = `fileURLToPath(import.meta?.url);`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      'fileURLToPath(import.meta.url?.startsWith("file:") ? import.meta.url : "file:///")',
    );
  });

  it("guards nested calls inside other expressions", () => {
    const code = `const p = path.resolve(fileURLToPath(import.meta.url), "x");`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      'fileURLToPath(import.meta.url?.startsWith("file:") ? import.meta.url : "file:///")',
    );
  });

  it("does not guard other functions taking import.meta.url", () => {
    const code = `someOtherFn(import.meta.url);`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).toBeNull();
  });

  it("returns null for unparseable code", () => {
    const result = guardImportMetaUrlCalls("const = ;");
    expect(result).toBeNull();
  });

  it("guards the guarded call's arguments and leaves out-of-scope calls untouched", () => {
    const code = `fileURLToPath(import.meta.url, pathToFileURL(import.meta.url));`;
    const result = guardImportMetaUrlCalls(code);
    expect(result!.code).toBe(
      'fileURLToPath(import.meta.url?.startsWith("file:") ? import.meta.url : "file:///", pathToFileURL(import.meta.url));',
    );
  });

  it("guards nested guarded calls inside other arguments", () => {
    const code = `fileURLToPath(import.meta.url, other(fileURLToPath(import.meta.url)));`;
    const result = guardImportMetaUrlCalls(code);
    expect(result!.code).toBe(
      'fileURLToPath(import.meta.url?.startsWith("file:") ? import.meta.url : "file:///", other(fileURLToPath(import.meta.url?.startsWith("file:") ? import.meta.url : "file:///")));',
    );
  });

  it("guards prettier trailing-comma and annotated call forms", () => {
    const code = `fileURLToPath(
  import.meta.url, // prettier trailing comma
);`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      'import.meta.url?.startsWith("file:") ? import.meta.url : "file:///"',
    );
  });

  it("does not touch the pattern inside strings or comments", () => {
    const code = `// fileURLToPath(import.meta.url) in a comment
const s = "fileURLToPath(import.meta.url) in a string";`;
    const result = guardImportMetaUrlCalls(code);
    expect(result).toBeNull();
  });

  describe("filter gate (production path)", () => {
    it("matches the canonical form", () => {
      expect(WORKERD_IMPORT_META_URL_FILTER.test("fileURLToPath(import.meta.url)")).toBe(true);
      expect(WORKERD_IMPORT_META_URL_FILTER.test("createRequire(import.meta.url)")).toBe(true);
    });

    it("matches long block comments between callee and argument", () => {
      const longComment = "/* " + "x".repeat(200) + " */";
      expect(
        WORKERD_IMPORT_META_URL_FILTER.test(`fileURLToPath(${longComment} import.meta.url)`),
      ).toBe(true);
      expect(
        WORKERD_IMPORT_META_URL_FILTER.test(`fileURLToPath(
  // a comment explaining why this call exists and spanning multiple
  // lines of prose that would exceed any bounded window
  import.meta.url
)`),
      ).toBe(true);
    });

    it("matches long block comments between the callee and opening parenthesis", () => {
      const longComment = "/* " + "x".repeat(200) + " */";
      expect(
        WORKERD_IMPORT_META_URL_FILTER.test(`fileURLToPath ${longComment} (import.meta.url)`),
      ).toBe(true);
      expect(
        WORKERD_IMPORT_META_URL_FILTER.test(`createRequire ${longComment} (import.meta.url)`),
      ).toBe(true);
    });

    it("matches comments around import.meta member access", () => {
      expect(
        WORKERD_IMPORT_META_URL_FILTER.test(
          "fileURLToPath(import.meta /* annotated access */ .url)",
        ),
      ).toBe(true);
      expect(
        WORKERD_IMPORT_META_URL_FILTER.test(
          "createRequire(import.meta. /* annotated property */ url)",
        ),
      ).toBe(true);
    });

    it("matches whitespace, comment, and trailing-comma variants", () => {
      expect(WORKERD_IMPORT_META_URL_FILTER.test("fileURLToPath (import.meta.url)")).toBe(true);
      expect(WORKERD_IMPORT_META_URL_FILTER.test("fileURLToPath(import.meta.url,)")).toBe(true);
      expect(WORKERD_IMPORT_META_URL_FILTER.test("fileURLToPath(import.meta.url /* why */)")).toBe(
        true,
      );
      expect(WORKERD_IMPORT_META_URL_FILTER.test("fileURLToPath(\n  import.meta.url,\n)")).toBe(
        true,
      );
    });

    it("does not match unrelated code", () => {
      expect(WORKERD_IMPORT_META_URL_FILTER.test("const u = import.meta.url;")).toBe(false);
      expect(WORKERD_IMPORT_META_URL_FILTER.test("someFn(import.meta.url)")).toBe(false);
    });
  });
});
