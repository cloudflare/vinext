#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shimRoot = path.join(repoRoot, "packages/vinext/src/shims");
const typesRoot = path.join(repoRoot, "packages/types/next");
const publicShimMap = JSON.parse(
  fs.readFileSync(path.join(shimRoot, "public-shim-map.json"), "utf-8"),
);
const generatedWrappers = fs.readFileSync(
  path.join(typesRoot, "next-shims-upstream.generated.d.ts"),
  "utf-8",
);
const googleFontData = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "packages/vinext/src/build/google-fonts/font-data.json"),
    "utf-8",
  ),
);

const upstreamTypes = new Map();
for (const match of generatedWrappers.matchAll(
  /declare module "([^"]+)" \{\s+export \* from "([^"]+)";/g,
)) {
  upstreamTypes.set(match[1], match[2]);
}

function toImportSpecifier(fromDir, target) {
  let specifier = path.relative(fromDir, target).split(path.sep).join("/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

function resolveShim(shim) {
  for (const extension of [".ts", ".tsx"]) {
    const candidate = path.join(shimRoot, `${shim}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find shim implementation for ${JSON.stringify(shim)}`);
}

function renderContracts(tempDir) {
  // These contracts verify the public values exported by each `next/*` shim.
  // Request handlers can also construct values described by those public
  // types (for example AppContext.router); those runtime construction sites
  // need their own typed boundaries and behavioral tests.
  const lines = [
    `/// <reference path=${JSON.stringify(toImportSpecifier(tempDir, path.join(typesRoot, "index.d.ts")))} />`,
    `/// <reference path=${JSON.stringify(toImportSpecifier(tempDir, path.join(repoRoot, "packages/vinext/src/global.d.ts")))} />`,
    `/// <reference path=${JSON.stringify(toImportSpecifier(tempDir, path.join(repoRoot, "packages/vinext/src/private-next-instrumentation-client.d.ts")))} />`,
    "",
  ];

  for (const [index, [moduleName, definition]] of Object.entries(publicShimMap).entries()) {
    const upstreamModule = definition.types === "upstream" ? upstreamTypes.get(moduleName) : null;
    if (definition.types === "upstream" && !upstreamModule) {
      throw new Error(`No vendored type entry was generated for ${JSON.stringify(moduleName)}`);
    }
    const expectedModule = upstreamModule
      ? toImportSpecifier(
          tempDir,
          path.join(typesRoot, upstreamModule.slice("@vinext/types/next/".length)),
        )
      : moduleName;
    const actualModule = toImportSpecifier(tempDir, resolveShim(definition.shim));

    lines.push(`import * as shim${index} from ${JSON.stringify(actualModule)};`);
    if (moduleName === "next/font/google") {
      const declarationsPath = path.join(
        typesRoot,
        `${upstreamModule.slice("@vinext/types/next/".length)}.d.ts`,
      );
      const declarations = fs.readFileSync(declarationsPath, "utf-8");
      const reExport = declarations.match(/export \* from ['"]([^'"]+)['"]/);
      const fontDeclarations = reExport
        ? fs.readFileSync(
            path.resolve(path.dirname(declarationsPath), `${reExport[1]}.d.ts`),
            "utf-8",
          )
        : declarations;
      const fontNames = Array.from(
        fontDeclarations.matchAll(/export declare function (\w+)/g),
        (match) => match[1],
      );
      if (fontNames.length === 0) {
        throw new Error("No Google Font exports were found in the vendored declarations");
      }
      for (const fontName of fontNames) {
        const family = fontName.replaceAll("_", " ");
        if (!Object.hasOwn(googleFontData, family)) {
          throw new Error(
            `Vendored Google Font ${JSON.stringify(fontName)} has no transform metadata entry`,
          );
        }
        lines.push(
          `const googleFont${index}_${fontName}: typeof import(${JSON.stringify(expectedModule)}).${fontName} = shim${index}.createFontLoader(${JSON.stringify(family)});`,
          `void googleFont${index}_${fontName};`,
        );
      }
      lines.push("");
      continue;
    }
    if (moduleName === "next/constants") {
      lines.push(
        `const contract${index}: Omit<typeof import(${JSON.stringify(expectedModule)}), "CLIENT_STATIC_FILES_RUNTIME_POLYFILLS_SYMBOL"> = shim${index};`,
      );
    } else if (moduleName === "next/router") {
      lines.push(
        `const contract${index}: Omit<typeof import(${JSON.stringify(expectedModule)}), "Router"> = shim${index};`,
        `type routerInstance${index} = { [Key in keyof InstanceType<typeof import(${JSON.stringify(expectedModule)}).Router>]: InstanceType<typeof import(${JSON.stringify(expectedModule)}).Router>[Key] };`,
        `const routerConstructor${index}: new (...args: ConstructorParameters<typeof import(${JSON.stringify(expectedModule)}).Router>) => routerInstance${index} = shim${index}.Router;`,
        `const routerStatics${index}: Pick<typeof import(${JSON.stringify(expectedModule)}).Router, "events"> = shim${index}.Router;`,
        `void routerConstructor${index};`,
        `void routerStatics${index};`,
      );
    } else if (moduleName === "next/server") {
      lines.push(
        `const contract${index}: Omit<typeof import(${JSON.stringify(expectedModule)}), "NextFetchEvent" | "NextRequest" | "NextResponse" | "URLPattern"> = shim${index};`,
        `type fetchEventInstance${index} = Pick<InstanceType<typeof import(${JSON.stringify(expectedModule)}).NextFetchEvent>, "sourcePage" | "request" | "respondWith" | "waitUntil" | "passThroughOnException">;`,
        `const fetchEventConstructor${index}: new (...args: ConstructorParameters<typeof import(${JSON.stringify(expectedModule)}).NextFetchEvent>) => fetchEventInstance${index} = shim${index}.NextFetchEvent;`,
        `type nextUrlInstance${index} = Pick<InstanceType<typeof import(${JSON.stringify(expectedModule)}).NextRequest>["nextUrl"], "buildId" | "locale" | "defaultLocale" | "domainLocale" | "searchParams" | "host" | "hostname" | "port" | "protocol" | "href" | "origin" | "pathname" | "hash" | "search" | "password" | "username" | "basePath" | "toString" | "toJSON"> & { clone(): nextUrlInstance${index} };`,
        `type nextRequestInstance${index} = Omit<InstanceType<typeof import(${JSON.stringify(expectedModule)}).NextRequest>, "nextUrl"> & { nextUrl: nextUrlInstance${index} };`,
        `const nextRequestConstructor${index}: new (...args: ConstructorParameters<typeof import(${JSON.stringify(expectedModule)}).NextRequest>) => nextRequestInstance${index} = shim${index}.NextRequest;`,
        `type nextResponseInstance${index} = Response & Pick<InstanceType<typeof import(${JSON.stringify(expectedModule)}).NextResponse>, "cookies">;`,
        `type nextResponseConstructor${index} = { new (...args: ConstructorParameters<typeof import(${JSON.stringify(expectedModule)}).NextResponse>): nextResponseInstance${index}; json<JsonBody>(body: JsonBody, init?: Parameters<typeof import(${JSON.stringify(expectedModule)}).NextResponse.json>[1]): nextResponseInstance${index}; redirect(...args: Parameters<typeof import(${JSON.stringify(expectedModule)}).NextResponse.redirect>): nextResponseInstance${index}; rewrite(...args: Parameters<typeof import(${JSON.stringify(expectedModule)}).NextResponse.rewrite>): nextResponseInstance${index}; next(...args: Parameters<typeof import(${JSON.stringify(expectedModule)}).NextResponse.next>): nextResponseInstance${index}; };`,
        `const nextResponseConstructor${index}: nextResponseConstructor${index} = shim${index}.NextResponse;`,
        `type urlPatternInstance${index} = Pick<InstanceType<typeof import(${JSON.stringify(expectedModule)}).URLPattern>, "protocol" | "username" | "password" | "hostname" | "port" | "pathname" | "search" | "hash" | "test"> & { exec: unknown };`,
        `const urlPatternPrototype${index}: urlPatternInstance${index} = shim${index}.URLPattern.prototype;`,
        `void fetchEventConstructor${index};`,
        `void nextRequestConstructor${index};`,
        `void nextResponseConstructor${index};`,
        `void urlPatternPrototype${index};`,
      );
    } else if (moduleName === "next/navigation") {
      lines.push(
        `const contract${index}: Omit<typeof import(${JSON.stringify(expectedModule)}), "ServerInsertedHTMLContext" | "useParams"> = shim${index};`,
        `const serverInsertedHTMLContext${index}: typeof import(${JSON.stringify(expectedModule)}).ServerInsertedHTMLContext | null = shim${index}.ServerInsertedHTMLContext;`,
        `const useParams${index}: <T extends Record<string, string | string[] | undefined> = Record<string, string | string[] | undefined>>() => T | null = shim${index}.useParams;`,
        `void serverInsertedHTMLContext${index};`,
        `void useParams${index};`,
      );
    } else {
      lines.push(
        `const contract${index}: typeof import(${JSON.stringify(expectedModule)}) = shim${index};`,
      );
    }
    lines.push(`void contract${index};`, "");
  }
  return lines.join("\n");
}

function main() {
  const tscPath = fileURLToPath(new URL("bin/tsc", import.meta.resolve("typescript/package.json")));
  for (const target of ["es2022", "esnext"]) {
    const declarationResult = spawnSync(
      process.execPath,
      [
        tscPath,
        "--ignoreConfig",
        "--strict",
        "--noEmit",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--target",
        target,
        path.join(typesRoot, "index.d.ts"),
      ],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    if (declarationResult.status !== 0) {
      process.stderr.write(declarationResult.stdout);
      process.stderr.write(declarationResult.stderr);
      process.exitCode = declarationResult.status ?? 1;
      return;
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-shim-types-"));
  const contractPath = path.join(tempDir, "contracts.ts");
  const tsconfigPath = path.join(tempDir, "tsconfig.json");
  try {
    fs.writeFileSync(contractPath, renderContracts(tempDir));
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: path.join(repoRoot, "tsconfig.json"),
        compilerOptions: {
          paths: {
            vinext: [
              toImportSpecifier(tempDir, path.join(repoRoot, "packages/vinext/src/index.ts")),
            ],
            "vinext/*": [toImportSpecifier(tempDir, path.join(repoRoot, "packages/vinext/src/*"))],
          },
        },
        files: [contractPath],
      }),
    );
    const result = spawnSync(process.execPath, [tscPath, "--project", tsconfigPath], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
      return;
    }
    console.log(
      `Public shim values match their vendored types (${Object.keys(publicShimMap).length} modules)`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
