import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";

const servers: ViteDevServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dev public ETag Vite configuration", () => {
  it("does not rewrite validators when publicDir is disabled", async () => {
    const root = createRoot();
    const publicDir = path.join(root, "public");
    fs.mkdirSync(publicDir);
    const filePath = path.join(publicDir, "asset.js");
    fs.writeFileSync(filePath, "hello");
    const strong = etagForFile(filePath).replace(/^W\//, "");

    const baseUrl = await startServer(root, false);
    const response = await fetch(`${baseUrl}/asset.js`, {
      headers: { "If-None-Match": strong },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-fallback-if-none-match")).toBe(strong);
    expect(await response.text()).toBe("fallback");
  });

  it("indexes only Vite's resolved custom publicDir", async () => {
    const root = createRoot();
    const defaultPublicDir = path.join(root, "public");
    const customPublicDir = path.join(root, "custom-public");
    fs.mkdirSync(defaultPublicDir);
    fs.mkdirSync(customPublicDir);
    const defaultFile = path.join(defaultPublicDir, "root-only.js");
    fs.writeFileSync(defaultFile, "wrong");
    fs.writeFileSync(path.join(customPublicDir, "asset.js"), "custom");

    const baseUrl = await startServer(root, "custom-public");
    const initial = await fetch(`${baseUrl}/asset.js`);
    expect(initial.status).toBe(200);
    expect(await initial.text()).toBe("custom");
    const etag = initial.headers.get("etag");
    expect(etag).toMatch(/^W\//);

    const conditional = await fetch(`${baseUrl}/asset.js`, {
      headers: { "If-None-Match": etag!.replace(/^W\//, "") },
    });
    expect(conditional.status).toBe(304);

    const rootOnlyStrong = etagForFile(defaultFile).replace(/^W\//, "");
    const fallback = await fetch(`${baseUrl}/root-only.js`, {
      headers: { "If-None-Match": rootOnlyStrong },
    });
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("x-fallback-if-none-match")).toBe(rootOnlyStrong);
    expect(await fallback.text()).toBe("fallback");
  });

  it.runIf(process.platform === "darwin")(
    "matches case and normalization aliases when a dangling symlink enables Vite stat lookup",
    async () => {
      const root = createRoot();
      const publicDir = path.join(root, "public");
      fs.mkdirSync(publicDir);
      const mixedCaseFile = path.join(publicDir, "MixedCase.js");
      const unicodeFile = path.join(publicDir, "Éclair.js");
      const sharpSFile = path.join(publicDir, "Straße.js");
      const dotlessIFile = path.join(publicDir, "ı.js");
      const sigmaFile = path.join(publicDir, "Σ.js");
      const ypogegrammeniFile = path.join(publicDir, "ͅ.js");
      const mixedExpansionFile = path.join(publicDir, "ßı.js");
      fs.writeFileSync(mixedCaseFile, "mixed");
      fs.writeFileSync(unicodeFile, "unicode");
      fs.writeFileSync(sharpSFile, "sharp-s");
      fs.writeFileSync(dotlessIFile, "dotless-i");
      fs.writeFileSync(sigmaFile, "sigma");
      fs.writeFileSync(ypogegrammeniFile, "ypogegrammeni");
      fs.writeFileSync(mixedExpansionFile, "mixed-expansion");
      fs.mkdirSync(path.join(publicDir, "Straße"));
      fs.writeFileSync(path.join(publicDir, "Straße", "Maße.js"), "nested-sharp-s");
      fs.symlinkSync("missing", path.join(publicDir, "0-broken"));

      const lowerCaseFile = path.join(publicDir, "mixedCase.js");
      if (fs.realpathSync.native(mixedCaseFile) !== fs.realpathSync.native(lowerCaseFile)) return;

      const baseUrl = await startServer(root, "public");
      const mixedEtag = (await fetch(`${baseUrl}/MixedCase.js`)).headers.get("etag");
      expect(mixedEtag).toMatch(/^W\//);
      expect(
        (
          await fetch(`${baseUrl}/mixedcase.js`, {
            headers: { "If-None-Match": mixedEtag!.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);

      const mixedExpansionEtag = (await fetch(`${baseUrl}/%C3%9F%C4%B1.js`)).headers.get("etag");
      expect(mixedExpansionEtag).toMatch(/^W\//);
      const mixedExpansionFallback = await fetch(`${baseUrl}/SSi.js`, {
        headers: { "If-None-Match": mixedExpansionEtag!.replace(/^W\//, "") },
      });
      expect(mixedExpansionFallback.status).toBe(200);
      expect(mixedExpansionFallback.headers.get("x-fallback-if-none-match")).toBe(
        mixedExpansionEtag!.replace(/^W\//, ""),
      );

      const ypogegrammeniEtag = (await fetch(`${baseUrl}/%CD%85.js`)).headers.get("etag");
      expect(ypogegrammeniEtag).toMatch(/^W\//);
      expect(
        (
          await fetch(`${baseUrl}/%CE%99.js`, {
            headers: { "If-None-Match": ypogegrammeniEtag!.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);

      const sigmaEtag = (await fetch(`${baseUrl}/%CE%A3.js`)).headers.get("etag");
      expect(sigmaEtag).toMatch(/^W\//);
      expect(
        (
          await fetch(`${baseUrl}/%CF%82.js`, {
            headers: { "If-None-Match": sigmaEtag!.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);

      const nestedEtag = (await fetch(`${baseUrl}/Stra%C3%9Fe/Ma%C3%9Fe.js`)).headers.get("etag");
      expect(nestedEtag).toMatch(/^W\//);
      expect(
        (
          await fetch(`${baseUrl}/STRASSE/MASSE.js`, {
            headers: { "If-None-Match": nestedEtag!.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);

      const dotlessIEtag = (await fetch(`${baseUrl}/%C4%B1.js`)).headers.get("etag");
      expect(dotlessIEtag).toMatch(/^W\//);
      const dottedFallback = await fetch(`${baseUrl}/i.js`, {
        headers: { "If-None-Match": dotlessIEtag!.replace(/^W\//, "") },
      });
      expect(dottedFallback.status).toBe(200);
      expect(dottedFallback.headers.get("x-fallback-if-none-match")).toBe(
        dotlessIEtag!.replace(/^W\//, ""),
      );

      const unicodeEtag = (await fetch(`${baseUrl}/%C3%89clair.js`)).headers.get("etag");
      expect(unicodeEtag).toMatch(/^W\//);
      expect(
        (
          await fetch(`${baseUrl}/%C3%A9clair.js`, {
            headers: { "If-None-Match": unicodeEtag!.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);

      const decomposedFile = path.join(publicDir, "E\u0301clair.js");
      if (fs.realpathSync.native(unicodeFile) === fs.realpathSync.native(decomposedFile)) {
        expect(
          (
            await fetch(`${baseUrl}/E%CC%81clair.js`, {
              headers: { "If-None-Match": unicodeEtag!.replace(/^W\//, "") },
            })
          ).status,
        ).toBe(304);
      }

      const sharpSEtag = (await fetch(`${baseUrl}/Stra%C3%9Fe.js`)).headers.get("etag");
      expect(sharpSEtag).toMatch(/^W\//);
      expect(
        (
          await fetch(`${baseUrl}/STRASSE.js`, {
            headers: { "If-None-Match": sharpSEtag!.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);
    },
  );

  it.runIf(process.platform === "darwin")(
    "expands normalization semantics when a file is added after startup",
    async () => {
      const root = createRoot();
      const publicDir = path.join(root, "public");
      fs.mkdirSync(publicDir);
      fs.writeFileSync(path.join(publicDir, "base.js"), "base");
      fs.symlinkSync("missing", path.join(publicDir, "0-broken"));

      const baseUrl = await startServer(root, "public");
      fs.writeFileSync(path.join(publicDir, "Éclair.js"), "unicode");

      await expect
        .poll(
          async () => {
            const canonical = await fetch(`${baseUrl}/%C3%89clair.js`);
            const etag = canonical.headers.get("etag");
            if (!etag) return canonical.status;
            return (
              await fetch(`${baseUrl}/E%CC%81clair.js`, {
                headers: { "If-None-Match": etag.replace(/^W\//, "") },
              })
            ).status;
          },
          { timeout: 5000 },
        )
        .toBe(304);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not fold or rewrite a wrong-case request for a symlinked public root",
    async () => {
      const root = createRoot();
      const actualPublicDir = path.join(root, "actual-public");
      const publicDir = path.join(root, "public");
      fs.mkdirSync(actualPublicDir);
      fs.writeFileSync(path.join(actualPublicDir, "MixedCase.js"), "content");
      fs.symlinkSync(actualPublicDir, publicDir, "dir");

      const baseUrl = await startServer(root, "public");
      const initial = await fetch(`${baseUrl}/MixedCase.js`);
      const strong = initial.headers.get("etag")!.replace(/^W\//, "");
      const fallback = await fetch(`${baseUrl}/mixedcase.js`, {
        headers: { "If-None-Match": strong },
      });

      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("x-fallback-if-none-match")).toBe(strong);
      expect(await fallback.text()).toBe("fallback");
    },
  );

  it.runIf(process.platform === "darwin")(
    "keeps Vite's exact public lookup mode when a symlink is added later",
    async () => {
      const root = createRoot();
      const publicDir = path.join(root, "public");
      fs.mkdirSync(publicDir);
      fs.writeFileSync(path.join(publicDir, "MixedCase.js"), "content");

      const baseUrl = await startServer(root, "public");
      const initial = await fetch(`${baseUrl}/MixedCase.js`);
      const strong = initial.headers.get("etag")!.replace(/^W\//, "");
      fs.symlinkSync("MixedCase.js", path.join(publicDir, "alias.js"));
      await expect.poll(async () => (await fetch(`${baseUrl}/alias.js`)).status).toBe(200);

      const fallback = await fetch(`${baseUrl}/mixedcase.js`, {
        headers: { "If-None-Match": strong },
      });
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("x-fallback-if-none-match")).toBe(strong);
    },
  );

  it.runIf(process.platform === "darwin")(
    "keeps Vite's stat lookup mode when its startup symlink is removed",
    async () => {
      const root = createRoot();
      const publicDir = path.join(root, "public");
      fs.mkdirSync(publicDir);
      fs.writeFileSync(path.join(publicDir, "MixedCase.js"), "content");
      const alias = path.join(publicDir, "alias.js");
      fs.symlinkSync("MixedCase.js", alias);

      const baseUrl = await startServer(root, "public");
      const initial = await fetch(`${baseUrl}/MixedCase.js`);
      const strong = initial.headers.get("etag")!.replace(/^W\//, "");
      fs.rmSync(alias);

      await expect
        .poll(
          async () =>
            (
              await fetch(`${baseUrl}/mixedcase.js`, {
                headers: { "If-None-Match": strong },
              })
            ).status,
        )
        .toBe(304);
    },
  );

  it.runIf(process.platform === "darwin")(
    "keeps unverified Unicode aliases distinct from dotted files and symlinks",
    async () => {
      const root = createRoot("ı-etag-root-");
      const publicDir = path.join(root, "public");
      fs.mkdirSync(publicDir);
      fs.writeFileSync(path.join(publicDir, "MixedCase.js"), "mixed");
      fs.writeFileSync(path.join(publicDir, "target.js"), "target");
      fs.symlinkSync("target.js", path.join(publicDir, "i.js"));

      const baseUrl = await startServer(root, "public");
      const mixedEtag = (await fetch(`${baseUrl}/MixedCase.js`)).headers.get("etag")!;
      expect(
        (
          await fetch(`${baseUrl}/mixedcase.js`, {
            headers: { "If-None-Match": mixedEtag.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);

      const dottedEtag = (await fetch(`${baseUrl}/i.js`)).headers.get("etag")!;
      const dotlessFallback = await fetch(`${baseUrl}/%C4%B1.js`, {
        headers: { "If-None-Match": dottedEtag.replace(/^W\//, "") },
      });
      expect(dotlessFallback.status).toBe(200);
      expect(dotlessFallback.headers.get("x-fallback-if-none-match")).toBe(
        dottedEtag.replace(/^W\//, ""),
      );
    },
  );
});

function createRoot(prefix = "vinext-dev-public-config-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function startServer(root: string, publicDir: string | false): Promise<string> {
  const fallbackPlugin: Plugin = {
    name: "test-public-etag-fallback",
    configureServer(server) {
      return () => {
        server.middlewares.use((req, res) => {
          const validator = req.headers["if-none-match"];
          if (typeof validator === "string") {
            res.setHeader("x-fallback-if-none-match", validator);
          }
          res.statusCode = 200;
          res.end("fallback");
        });
      };
    },
  };

  const server = await createServer({
    root,
    publicDir,
    configFile: false,
    plugins: [vinext(), fallbackPlugin],
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  servers.push(server);
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP dev server");
  return `http://127.0.0.1:${address.port}`;
}

function etagForFile(filePath: string): string {
  const stats = fs.statSync(filePath);
  return `W/"${stats.size}-${stats.mtime.getTime()}"`;
}
