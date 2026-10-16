#!/usr/bin/env node
/**
 * Checks next/image in a dev server running an app with vinext installed from
 * its packed tarball. Installed packages live under node_modules, where Vite's
 * dep optimizer and @vitejs/plugin-rsc treat vinext's shims differently from
 * the workspace link the in-repo tests use.
 *
 * Usage:
 *   node scripts/check-installed-next-image.mjs write <app-dir>
 *   node scripts/check-installed-next-image.mjs check <base-url>
 *
 * `write` adds app/image-check/ to the app: a Server Component calling
 * getImageProps and rendering Image, plus a Client Component rendering Image.
 * Run it before starting the dev server. `check` then waits for
 * <base-url>/image-check to render on the first request and hydrate without
 * errors or reloads.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [command, target] = process.argv.slice(2);
if (command === "write" && target) {
  const pageDir = path.join(target, "app", "image-check");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(
    path.join(pageDir, "page.tsx"),
    `import Image, { getImageProps } from "next/image";
import ClientImage from "./client-image";

export default function Page() {
  const { props } = getImageProps({ src: "/next.svg", alt: "props", width: 100, height: 20 });
  return (
    <main>
      <img id="props-image" {...props} />
      <Image id="server-image" src="/next.svg" alt="server" width={100} height={20} />
      <ClientImage />
    </main>
  );
}
`,
  );
  fs.writeFileSync(
    path.join(pageDir, "client-image.tsx"),
    `"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export default function ClientImage() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <div id="client-image" data-hydrated={String(hydrated)}>
      <Image src="/next.svg" alt="client" width={100} height={20} />
    </div>
  );
}
`,
  );
  process.exit(0);
}
if (command !== "check" || !target) {
  console.error(
    "Usage: node scripts/check-installed-next-image.mjs write <app-dir> | check <base-url>",
  );
  process.exit(1);
}

const url = new URL("/image-check", target).href;

// Wait only for the server to listen. The browser makes the first request to
// the page, so a failure or reload on that cold request fails the check.
async function waitForServer() {
  const deadline = Date.now() + 120_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/@vite/client", target), {
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      return;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${target} did not start listening within 2 minutes: ${lastError}`);
}

await waitForServer();

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  let loads = 0;
  page.on("load", () => loads++);

  const response = await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  const html = (await response?.text()) ?? "";
  if (response?.status() !== 200) {
    throw new Error(`${url} responded with ${response?.status()}: ${html.slice(0, 2000)}`);
  }
  for (const id of ["props-image", "server-image", "client-image"]) {
    if (!html.includes(`id="${id}"`)) errors.push(`SSR HTML is missing #${id}`);
  }
  try {
    await page.waitForSelector('#client-image[data-hydrated="true"]', { timeout: 30_000 });
    // Give a late dependency optimization (which reloads the page) time to land.
    await page.waitForTimeout(3000);
  } catch {
    errors.push("the page did not hydrate");
  }

  const images = await page.$$eval("#props-image, #server-image, #client-image img", (imgs) =>
    imgs.map((img) => ({
      alt: img.alt,
      src: img.getAttribute("src"),
      loaded: img.naturalWidth > 0,
    })),
  );
  console.log(JSON.stringify(images));
  if (images.length !== 3 || images.some((image) => !image.loaded)) {
    errors.push(`expected three loaded images, got ${JSON.stringify(images)}`);
  }
  if (loads !== 1) errors.push(`page reloaded: ${loads} loads`);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.log(`${url} rendered getImageProps and hydrated Image without errors`);
} finally {
  await browser.close();
}
