import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { createExtensionlessDynamicImportPlugin } from "../packages/vinext/src/plugins/extensionless-dynamic-import.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

function createTransform(extensions?: string[]): Function {
  const plugin = createExtensionlessDynamicImportPlugin();
  if (extensions) {
    unwrapHook(plugin.configResolved).call(plugin, { resolve: { extensions } });
  }
  return unwrapHook(plugin.transform).bind(plugin);
}

function createPackageFixture(
  packageName: string,
  exports: Record<string, unknown>,
  files: Record<string, string> = { "index.js": "export {};\n" },
) {
  const root = mkdtempSync(path.join(tmpdir(), "vinext-package-dynamic-import-"));
  tempDirs.push(root);
  const packageRoot = path.join(root, "node_modules", ...packageName.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, type: "module", exports }),
  );
  for (const [filename, contents] of Object.entries(files)) {
    const target = path.join(packageRoot, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return { root, packageRoot, importer: path.join(root, "entry.ts") };
}

describe("vinext:extensionless-dynamic-import", () => {
  it("expands extensionless relative template imports through import.meta.glob", () => {
    const transform = createTransform();
    const result = transform("const moduleExports = await import(`./${slug}`)", "/app/page.tsx");

    expect(result.code).toContain('import.meta.glob("./**/*")');
    expect(result.code).toContain("__vinextModules[__vinextPath + __vinextExtension]");
    expect(result.code).toContain('__vinextPath + "/index" + __vinextExtension');
    expect(result.code).toContain("Promise.reject(new Error");
  });

  it("uses configured resolver extensions in priority order", () => {
    const transform = createTransform([".platform.tsx", ".tsx", ".js", ".json"]);
    const result = transform("await import(`./${slug}`)", "/app/page.tsx");

    expect(result.code).toContain('import.meta.glob("./**/*")');
    expect(result.code).toContain('[".platform.tsx",".tsx",".js",".json"]');
  });

  it("uses configured single resolver extensions at runtime", () => {
    const transform = createTransform([".js"]);
    const result = transform("await import(`./${slug}`)", "/app/page.tsx");

    expect(result.code).toContain('import.meta.glob("./**/*")');
    expect(result.code).toContain('[".js"]');
  });

  it("tries every file extension before directory index files", () => {
    const transform = createTransform([".tsx", ".js"]);
    const result = transform("await import(`./${slug}`)", "/app/page.tsx");

    expect(result.code.indexOf("__vinextPath + __vinextExtension")).toBeLessThan(
      result.code.indexOf('__vinextPath + "/index" + __vinextExtension'),
    );
    expect(result.code).not.toContain(
      '__vinextModules[__vinextPath + __vinextExtension] ?? __vinextModules[__vinextPath + "/index"',
    );
  });

  it("transforms imports separated from the call parenthesis by newlines", () => {
    const transform = createTransform();
    const result = transform("await import\n(`./${slug}`)", "/app/page.tsx");

    expect(result.code).toContain("import.meta.glob");
  });

  it("reuses the cached transform result for a repeated id/source pair", () => {
    const transform = createTransform();
    const source = "await import(`./${slug}`)";

    const first = transform(source, "/app/page.tsx");
    expect(first).toBeTruthy();
    expect(transform(source, "/app/page.tsx")).toBe(first);
    expect(transform("await import(`./other/${slug}`)", "/app/page.tsx")).not.toBe(first);
    expect(transform(source, "/app/other.tsx")).not.toBe(first);
  });

  it("keeps cached results distinct across resolver extension configs", () => {
    const plugin = createExtensionlessDynamicImportPlugin();
    const configResolved = unwrapHook(plugin.configResolved).bind(plugin);
    const transform = unwrapHook(plugin.transform).bind(plugin);
    const source = "await import(`./${slug}`)";

    configResolved({ resolve: { extensions: [".tsx"] } });
    const first = transform(source, "/app/page.tsx");
    expect(first.code).toContain('[".tsx"]');

    configResolved({ resolve: { extensions: [".js"] } });
    const second = transform(source, "/app/page.tsx");
    expect(second).not.toBe(first);
    expect(second.code).toContain('[".js"]');
  });

  it("transforms imports with a static filename prefix", () => {
    const transform = createTransform();
    const result = transform("await import(`./components/prefixed-${slug}`)", "/app/page.tsx");

    expect(result.code).toContain(
      'import.meta.glob(["./components/prefixed-*","./components/prefixed-*/**/*"])',
    );
  });

  it("transforms imports with Webpack magic comments", () => {
    const transform = createTransform();
    const result = transform(
      'await import(/* webpackChunkName: "named" */ `./${slug}`)',
      "/app/page.tsx",
    );

    expect(result.code).toContain("import.meta.glob");
  });

  it("handles repeated block-comment markers without backtracking", () => {
    const transform = createTransform();
    const comments = "/*" + "*//*".repeat(10_000) + "*/";
    const result = transform(`await import(${comments} \`./\${slug}\`)`, "/app/page.tsx");

    expect(result.code).toContain("import.meta.glob");
  });

  it("leaves imports with explicit extensions unchanged", () => {
    const transform = createTransform();
    const result = transform("await import(`./${slug}.tsx`)", "/app/page.tsx");

    expect(result).toBeNull();
  });

  it("leaves bare package imports unchanged", () => {
    const transform = createTransform();
    const result = transform("await import(`${packageName}`)", "/app/page.tsx");

    expect(result).toBeNull();
  });

  it("expands variable package subpath imports through wildcard exports", () => {
    // Mirrors nodejs.org's workspace package and import:
    // https://github.com/nodejs/nodejs.org/blob/main/packages/i18n/package.json
    // https://github.com/nodejs/nodejs.org/blob/main/apps/site/i18n.tsx
    const root = mkdtempSync(path.join(tmpdir(), "vinext-package-dynamic-import-"));
    tempDirs.push(root);
    const appRoot = path.join(root, "apps", "site");
    const packageRoot = path.join(root, "packages", "i18n");
    mkdirSync(path.join(packageRoot, "src", "locales"), { recursive: true });
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@node-core/website-i18n",
        type: "module",
        exports: {
          "./*": ["./src/*", "./src/*.d.ts", "./src/*.mjs", "./src/*.json"],
          ".": "./src/index.mjs",
        },
      }),
    );
    writeFileSync(path.join(packageRoot, "src", "index.mjs"), "export const locales = ['en'];\n");
    const packageLink = path.join(appRoot, "node_modules", "@node-core", "website-i18n");
    mkdirSync(path.dirname(packageLink), { recursive: true });
    symlinkSync(packageRoot, packageLink, process.platform === "win32" ? "junction" : "dir");

    const transform = createTransform();
    const importer = path.join(appRoot, "i18n.tsx");
    const result = transform(
      "await import(`@node-core/website-i18n/locales/${locale}.json`)",
      importer,
    );

    expect(result.code).toContain('"../../packages/i18n/src/locales/*.json"');
    expect(result.code).toContain("{ exhaustive: true }");
    expect(result.code).toContain('"@node-core/website-i18n/".length');
    expect(result.code).toContain('"../../packages/i18n/src/" + __vinextCapture');
  });

  it("honors the most specific wildcard export and explicit null targets", () => {
    const packageName = "private-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": "./src/*",
      "./private/*": null,
    });

    const transform = createTransform();
    expect(
      transform("await import(`private-locales/private/${locale}.json`)", importer),
    ).toBeNull();
  });

  it("does not let a variable cross into a more-specific null export", () => {
    const packageName = "variable-private-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": "./src/*",
      "./private/*": null,
    });

    const transform = createTransform();
    expect(transform("await import(`variable-private-locales/${name}.json`)", importer)).toBeNull();
  });

  it("does not let a variable cross into an exact export", () => {
    const packageName = "variable-exact-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": "./src/*",
      "./special.json": "./special.js",
    });

    const transform = createTransform();
    expect(transform("await import(`variable-exact-locales/${name}.json`)", importer)).toBeNull();
  });

  it("selects the most specific wildcard export independent of insertion order", () => {
    const packageName = "specific-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": "./src/*",
      "./locales/*": "./translations/*",
    });

    const result = createTransform()(
      "await import(`specific-locales/locales/${locale}.json`)",
      importer,
    );
    expect(result.code).toContain('"./node_modules/specific-locales/translations/*.json"');
    expect(result.code).not.toContain("/src/");
  });

  it("does not skip a valid unsupported first exports-array target", () => {
    const packageName = "array-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": ["./shared.js", "./src/*"],
    });

    expect(createTransform()("await import(`array-locales/${locale}.json`)", importer)).toBeNull();
  });

  it("uses each Vite environment's export conditions and production state", () => {
    const packageName = "conditional-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./locales/*": {
        "react-server": {
          development: "./rsc-development/*",
          production: "./rsc-production/*",
        },
        default: "./client/*",
      },
    });
    const plugin = createExtensionlessDynamicImportPlugin();
    const transform = unwrapHook(plugin.transform);
    const source = "await import(`conditional-locales/locales/${locale}.json`)";
    const extensions = [".js", ".json"];

    const rsc = transform.call(
      {
        environment: {
          config: {
            isProduction: true,
            resolve: {
              extensions,
              conditions: ["react-server", "node", "development|production"],
            },
          },
        },
      },
      source,
      importer,
    );
    const client = transform.call(
      {
        environment: {
          config: {
            isProduction: false,
            resolve: { extensions, conditions: ["browser", "development|production"] },
          },
        },
      },
      source,
      importer,
    );

    expect(rsc.code).toContain("/rsc-production/");
    expect(client.code).toContain("/client/");
    expect(client).not.toBe(rsc);
  });

  it("does not bypass Vite aliases when resolving package imports", () => {
    const packageName = "aliased-locales";
    const { root, importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": "./physical-a/*",
    });
    const aliasedPackageRoot = path.join(root, "node_modules", "replacement-locales");
    mkdirSync(aliasedPackageRoot, { recursive: true });
    writeFileSync(
      path.join(aliasedPackageRoot, "package.json"),
      JSON.stringify({
        name: "replacement-locales",
        type: "module",
        exports: { ".": "./index.js", "./*": "./physical-b/*" },
      }),
    );
    writeFileSync(path.join(aliasedPackageRoot, "index.js"), "export {};\n");

    const plugin = createExtensionlessDynamicImportPlugin();
    unwrapHook(plugin.configResolved).call(plugin, {
      resolve: {
        alias: [{ find: packageName, replacement: "replacement-locales" }],
        conditions: [],
        extensions: [".js", ".json"],
      },
    });
    const result = unwrapHook(plugin.transform).call(
      plugin,
      "await import(`aliased-locales/${locale}.json`)",
      importer,
    );

    expect(result).toBeNull();
  });

  it.each([
    { find: "aliased-locales/special.json", replacement: "replacement-locales/special.json" },
    { find: /^aliased-locales\/.+/, replacement: "replacement-locales/$&" },
  ])("does not let a variable package import cross alias $find", (alias) => {
    const packageName = "aliased-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": "./physical/*",
    });
    const plugin = createExtensionlessDynamicImportPlugin();
    unwrapHook(plugin.configResolved).call(plugin, {
      resolve: {
        alias: [alias],
        conditions: [],
        extensions: [".js", ".json"],
      },
    });

    expect(
      unwrapHook(plugin.transform).call(
        plugin,
        "await import(`aliased-locales/${locale}.json`)",
        importer,
      ),
    ).toBeNull();
  });

  it.each([
    { find: /^@vite\/env$/, filename: "env.mjs" },
    { find: /^@vite\/client$/, filename: "client.mjs" },
  ])("ignores Vite's dist client alias $find", ({ find, filename }) => {
    const packageName = "vite-internal-alias-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": "./messages/*",
    });
    const plugin = createExtensionlessDynamicImportPlugin();
    unwrapHook(plugin.configResolved).call(plugin, {
      resolve: {
        alias: [
          {
            find,
            replacement: `/workspace/node_modules/vite/dist/client/${filename}`,
          },
        ],
        conditions: [],
        extensions: [".js", ".json"],
      },
    });

    const result = unwrapHook(plugin.transform).call(
      plugin,
      "await import(`vite-internal-alias-locales/${locale}.json`)",
      importer,
    );

    expect(result?.code).toContain("import.meta.glob");
  });

  it("does not cross a nested package scope for package self-resolution", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vinext-package-dynamic-import-"));
    tempDirs.push(root);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "root-locales", exports: { "./*": "./messages/*" } }),
    );
    const appRoot = path.join(root, "apps", "site");
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "site" }));

    const result = createTransform()(
      "await import(`root-locales/${locale}.json`)",
      path.join(appRoot, "entry.ts"),
    );

    expect(result).toBeNull();
  });

  it("bundles wildcard exports from packages physically installed in node_modules", async () => {
    const packageName = "installed-locales";
    const { root, importer } = createPackageFixture(
      packageName,
      { "./*": "./messages[prod]/*" },
      {
        "messages[prod]/en.json": '{"message":"English installed package"}',
        "messages[prod]/locales/de.json": '{"message":"German nested installed package"}',
      },
    );
    writeFileSync(
      importer,
      `export async function load(subpath: string) {
  return (await import(\`installed-locales/\${subpath}\`)).default;
}\n`,
    );

    const result = await build({
      root,
      logLevel: "silent",
      plugins: [createExtensionlessDynamicImportPlugin()],
      build: {
        lib: { entry: importer, formats: ["es"] },
        write: false,
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      "output" in item ? item.output : [],
    );
    const emittedCode = outputs
      .filter((item) => item.type === "chunk")
      .map((item) => item.code)
      .join("\n");

    expect(emittedCode).toContain("English installed package");
    expect(emittedCode).toContain("German nested installed package");
  });

  it("decodes package export targets and runtime captures like Node", async () => {
    const packageName = "encoded-locales";
    const { root, importer } = createPackageFixture(
      packageName,
      { "./*": "./messages%20files/*" },
      {
        "messages files/hello world.js": 'export default "decoded package import";\n',
        "messages files/hash#file.js": 'export default "decoded hash import";\n',
        "messages files/foo/bar.js": 'export default "normalized slash import";\n',
      },
    );
    writeFileSync(
      importer,
      `export async function load(subpath) {
  return (await import(\`encoded-locales/\${subpath}\`)).default;
}
export async function loadStaticPrefix(name) {
  return (await import(\`encoded-locales/hello%20\${name}.js\`)).default;
}\n`,
    );

    await build({
      root,
      logLevel: "silent",
      plugins: [createExtensionlessDynamicImportPlugin()],
      build: {
        lib: { entry: importer, formats: ["es"], fileName: () => "entry.mjs" },
        outDir: "dist",
      },
    });
    const output = await import(pathToFileURL(path.join(root, "dist", "entry.mjs")).href);

    await expect(output.load("hello%20world.js")).resolves.toBe("decoded package import");
    await expect(output.loadStaticPrefix("world")).resolves.toBe("decoded package import");
    await expect(output.load("hash%23file.js")).resolves.toBe("decoded hash import");
    await expect(output.load("hash#file.js")).rejects.toThrow("Cannot find module");
    await expect(output.load("foo//bar.js")).resolves.toBe("normalized slash import");
    await expect(output.load("/foo/bar.js")).resolves.toBe("normalized slash import");
  });

  it("rejects Node-forbidden runtime package subpath segments", () => {
    const packageName = "validated-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": "./src/*",
    });

    const result = createTransform()("await import(`validated-locales/${subpath}`)", importer);
    expect(result.code).toContain("decodeURIComponent(__vinextSegment)");
    expect(result.code).toContain('__vinextSegment.toLowerCase() === "node_modules"');
    expect(result.code).toContain("!./node_modules/validated-locales/src/**/node_modules/**");
  });

  it.each([
    "./src/../private/*",
    "./src/%2e%2e/private/*",
    "./src/node_modules/*",
    "./src#fragment/*",
    "./src?query/*",
  ])("leaves Node-invalid package export target %s unchanged", (target) => {
    const packageName = "invalid-target-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./*": target,
    });

    expect(
      createTransform()(`await import(\`invalid-target-locales/\${locale}.json\`)`, importer),
    ).toBeNull();
  });

  it("escapes package export metadata embedded in generated JavaScript", () => {
    const packageName = "escaped-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./prefix</script>/*</script>": "./messages</script>/*</script>",
    });

    const importSource = "`escaped-locales/prefix</script>/${locale}</script>`";
    const result = createTransform()(`await import(${importSource})`, importer);

    expect(result.code.replace(importSource, "")).not.toContain("</script>");
    expect(result.code).toContain("\\u003C/script\\u003E");
  });

  it("filters out dependency imports before invoking the handler", () => {
    const plugin = createExtensionlessDynamicImportPlugin();
    if (!plugin.transform || typeof plugin.transform === "function") {
      throw new Error("filtered transform hook not found");
    }
    const idFilter = plugin.transform.filter?.id as { exclude?: RegExp } | undefined;

    expect(idFilter?.exclude?.test("/app/node_modules/example-package/index.js")).toBe(true);
  });

  it("leaves imports with attributes unchanged", () => {
    const transform = createTransform();
    const result = transform(
      'await import(`./${slug}`, { with: { type: "json" } })',
      "/app/page.tsx",
    );

    expect(result).toBeNull();
  });

  it("preserves native imports when percent escapes can span an export wildcard", () => {
    const packageName = "split-escape-locales";
    const { importer } = createPackageFixture(packageName, {
      ".": "./index.js",
      "./foo*0bar": "./src/*0file.js",
    });

    expect(
      createTransform()(`await import(\`split-escape-locales/foo\${value}0bar\`)`, importer),
    ).toBeNull();
  });

  it.each([
    "await import(`./${slug}?raw`)",
    "await import(`./${slug}#section`)",
    "await import(`./[locale]/${slug}`)",
    "await import(`./${first}*/${second}`)",
    "await import(`./${first}.bak/${second}`)",
    "await import(`./${first}?query/${second}`)",
    "await import(`./file.${extension}`)",
  ])("leaves semantic import modifiers unchanged: %s", (code) => {
    const transform = createTransform();
    expect(transform(code, "/app/page.tsx")).toBeNull();
  });
});
