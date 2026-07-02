import { afterEach, describe, expect, it } from "vite-plus/test";
import { build } from "vite-plus";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../../packages/vinext/src/index.js";

let tmpRoot: string | undefined;

async function symlinkWorkspacePackage(nodeModulesDir: string, packageName: string): Promise<void> {
  const workspaceNodeModules = path.resolve(import.meta.dirname, "../../node_modules");
  const target = path.join(workspaceNodeModules, ...packageName.split("/"));
  const link = path.join(nodeModulesDir, ...packageName.split("/"));

  await fsp.mkdir(path.dirname(link), { recursive: true });
  await fsp.symlink(target, link, "junction");
}

async function writePrerenderNativeModuleFixture(root: string): Promise<void> {
  const nodeModulesDir = path.join(root, "node_modules");
  await fsp.mkdir(path.join(root, "pages", "blog"), { recursive: true });
  await fsp.mkdir(nodeModulesDir, { recursive: true });

  await Promise.all(
    ["react", "react-dom", "scheduler", "next", "ipaddr.js", "vite"].map((packageName) =>
      symlinkWorkspacePackage(nodeModulesDir, packageName),
    ),
  );

  await fsp.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
  );
  await fsp.writeFile(
    path.join(root, "data.sqlite"),
    JSON.stringify({
      users: [
        { id: 1, first_name: "john", last_name: "deux" },
        { id: 2, first_name: "zeit", last_name: "geist" },
      ],
    }),
  );

  const sqliteDir = path.join(nodeModulesDir, "sqlite");
  await fsp.mkdir(sqliteDir, { recursive: true });
  await fsp.writeFile(
    path.join(sqliteDir, "package.json"),
    JSON.stringify({ name: "sqlite", version: "0.0.0-test", type: "module", main: "index.js" }),
  );
  await fsp.writeFile(
    path.join(sqliteDir, "index.js"),
    `import fs from "node:fs/promises";

export async function open({ filename, driver }) {
  if (typeof driver !== "function") {
    throw new Error("expected sqlite3.Database driver");
  }
  if (driver.externalMarker !== "sqlite3-native-external-marker") {
    throw new Error("expected sqlite3.Database from the sqlite3 package");
  }
  const data = JSON.parse(await fs.readFile(filename, "utf8"));
  return {
    async all(sql) {
      if (sql !== "SELECT * FROM users") {
        throw new Error("unexpected SQL: " + sql);
      }
      return data.users;
    },
  };
}
`,
  );

  const sqlite3Dir = path.join(nodeModulesDir, "sqlite3");
  await fsp.mkdir(sqlite3Dir, { recursive: true });
  await fsp.writeFile(
    path.join(sqlite3Dir, "package.json"),
    JSON.stringify({ name: "sqlite3", version: "0.0.0-test", main: "index.js" }),
  );
  await fsp.writeFile(path.join(sqlite3Dir, "binding.node"), "native placeholder\n");
  await fsp.writeFile(
    path.join(sqlite3Dir, "index.js"),
    `const path = require("node:path");

class Database {}
Database.nativeBindingPath = path.join(__dirname, "binding.node");
Database.externalMarker = "sqlite3-native-external-marker";

module.exports = {
  Database,
  dir: __dirname,
};
`,
  );

  await fsp.writeFile(
    path.join(root, "pages", "index.tsx"),
    `export const getStaticProps = () => {
  return {
    props: {
      index: true,
    },
  };
};

export default function Page(props) {
  return (
    <>
      <p id="index">index page</p>
      <p id="props">{JSON.stringify(props)}</p>
    </>
  );
}
`,
  );

  await fsp.writeFile(
    path.join(root, "pages", "blog", "[slug].tsx"),
    `import path from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { useRouter } from "next/router";

export const getStaticProps = async ({ params }) => {
  const dbPath = path.join(process.cwd(), "data.sqlite");

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  const users = await db.all("SELECT * FROM users");

  return {
    props: {
      users,
      blog: true,
      params: params || null,
    },
  };
};

export const getStaticPaths = () => {
  return {
    paths: ["/blog/first"],
    fallback: true,
  };
};

export default function Page(props) {
  const router = useRouter();

  if (router.isFallback) {
    return "Loading...";
  }

  return (
    <>
      <p id="blog">blog page</p>
      <p id="props">{JSON.stringify(props)}</p>
    </>
  );
}
`,
  );
}

async function buildPagesFixtureToOutDir(root: string, outDir: string): Promise<void> {
  await build({
    root,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true })],
    logLevel: "silent",
    build: {
      outDir: path.join(outDir, "server"),
      ssr: "virtual:vinext-server-entry",
      rollupOptions: { output: { entryFileNames: "entry.js" } },
    },
  });

  await build({
    root,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true })],
    logLevel: "silent",
    build: {
      outDir: path.join(outDir, "client"),
      manifest: true,
      ssrManifest: true,
      rollupOptions: { input: "virtual:vinext-client-entry" },
    },
  });
}

function decodeHtmlText(text: string): string {
  return text.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
}

function elementText(html: string, id: string): string {
  const match = html.match(new RegExp(`<p id="${id}">([^<]*)</p>`));
  expect(match).not.toBeNull();
  return decodeHtmlText(match![1]);
}

async function fetchHtml(baseUrl: string, pathname: string): Promise<string> {
  const response = await fetch(`${baseUrl}${pathname}`);
  expect(response.status).toBe(200);
  return response.text();
}

async function fetchJson(baseUrl: string, pathname: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`);
  expect(response.status).toBe(200);
  return response.json();
}

function extractNextData(html: string): Record<string, unknown> {
  const match = html.match(
    /<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>(.*?)<\/script>/s,
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]);
}

function expectedBlogProps(slug: string) {
  return {
    params: { slug },
    blog: true,
    users: [
      { id: 1, first_name: "john", last_name: "deux" },
      { id: 2, first_name: "zeit", last_name: "geist" },
    ],
  };
}

function expectNextDataPageProps(value: unknown, pageProps: Record<string, unknown>): void {
  expect(value).toMatchObject({ pageProps });
}

afterEach(async () => {
  if (tmpRoot) {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

// Ported from Next.js: test/e2e/prerender-native-module.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/prerender-native-module.test.ts
describe("prerender native module", () => {
  it("renders static Pages routes that read sqlite3 during getStaticProps", async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-prerender-native-module-"));
    const outDir = path.join(tmpRoot, "dist");
    const originalCwd = process.cwd();

    try {
      await writePrerenderNativeModuleFixture(tmpRoot);
      process.chdir(tmpRoot);
      await buildPagesFixtureToOutDir(tmpRoot, outDir);
      const serverEntry = await fsp.readFile(path.join(outDir, "server", "entry.js"), "utf8");
      expect(serverEntry).toContain('from"sqlite3"');
      expect(serverEntry).not.toContain("nativeBindingPath");
      expect(serverEntry).not.toContain("binding.node");

      const { runPrerender } = await import("../../packages/vinext/src/build/run-prerender.js");
      await runPrerender({
        root: tmpRoot,
        pagesBundlePath: path.join(outDir, "server", "entry.js"),
        concurrency: 1,
      });

      const { startProdServer } = await import("../../packages/vinext/src/server/prod-server.js");
      const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir });
      const server = "server" in started ? started.server : started;

      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected production server to listen on a TCP port");
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const indexHtml = await fetchHtml(baseUrl, "/");
        expect(elementText(indexHtml, "index")).toBe("index page");
        expect(JSON.parse(elementText(indexHtml, "props"))).toEqual({
          index: true,
        });

        const firstHtml = await fetchHtml(baseUrl, "/blog/first");
        expect(elementText(firstHtml, "blog")).toBe("blog page");
        expect(JSON.parse(elementText(firstHtml, "props"))).toEqual(expectedBlogProps("first"));

        const secondFallbackHtml = await fetchHtml(baseUrl, "/blog/second");
        expect(secondFallbackHtml).toContain("Loading...");
        const secondFallbackData = extractNextData(secondFallbackHtml);
        expect(secondFallbackData.isFallback).toBe(true);
        const buildId = secondFallbackData.buildId;
        if (typeof buildId !== "string") {
          throw new Error("Expected __NEXT_DATA__.buildId to be a string");
        }

        const secondJson = await fetchJson(baseUrl, `/_next/data/${buildId}/blog/second.json`);
        expectNextDataPageProps(secondJson, expectedBlogProps("second"));

        const secondHtml = await fetchHtml(baseUrl, "/blog/second");
        expect(elementText(secondHtml, "blog")).toBe("blog page");
        expect(JSON.parse(elementText(secondHtml, "props"))).toEqual(expectedBlogProps("second"));
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      process.chdir(originalCwd);
    }
  }, 120_000);
});
