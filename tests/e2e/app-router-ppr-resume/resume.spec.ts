import { expect, test } from "../fixtures";

// A Cache Components route served from its fallback shell sends the stored
// shell at once and streams only its holes, as Next.js's partial prerendering
// resumes it. The fixture's shell probe is a client component that busy-waits
// during SSR and counts its renders, so a request that renders the shell again
// instead of resuming it shows up in both its timing and the counter.

type ServerWork = Record<string, number>;

async function readServerWork(baseURL: string): Promise<ServerWork> {
  const response = await fetch(new URL("/api/counters", baseURL));
  return (await response.json()) as ServerWork;
}

type StreamedDocument = {
  headers: Headers;
  html: string;
  firstByteMs: number;
  /** When each marker first appeared, in ms since the request started. */
  markers: Record<string, number>;
};

async function readStreamedDocument(
  url: URL,
  markers: readonly string[],
): Promise<StreamedDocument> {
  const start = performance.now();
  const response = await fetch(url, { headers: { cookie: "name=ada" } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const seen: Record<string, number> = {};
  let html = "";
  let firstByteMs = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = performance.now() - start;
    if (firstByteMs === -1) firstByteMs = now;
    html += decoder.decode(value, { stream: true });
    for (const marker of markers) {
      if (seen[marker] === undefined && html.includes(marker)) seen[marker] = now;
    }
  }
  return { headers: response.headers, html, firstByteMs, markers: seen };
}

test("resumes a fallback shell instead of rendering it again", async ({ baseURL }) => {
  // The first request for the route renders its shell and stores it.
  await readStreamedDocument(new URL("/en/blog/first", baseURL), []);

  const before = await readServerWork(baseURL!);
  const shellStamps = new Set<string>();
  for (const slug of ["second", "third"]) {
    const document = await readStreamedDocument(new URL(`/en/blog/${slug}`, baseURL), [
      'id="shell-stamp"',
      `<p id="slug">${slug}</p>`,
      '<p id="greeting">',
    ]);

    expect(document.headers.get("x-nextjs-postponed")).toBe("1");
    expect(document.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    // The shell, with the slug the request fills in, arrives before the
    // greeting hole, which waits 1.5s for its data.
    const shellAt = document.markers['id="shell-stamp"'];
    const slugAt = document.markers[`<p id="slug">${slug}</p>`];
    const greetingAt = document.markers['<p id="greeting">'];
    expect(shellAt).toBeDefined();
    expect(slugAt).toBeDefined();
    expect(greetingAt).toBeDefined();
    expect(shellAt).toBeLessThan(1_000);
    expect(greetingAt - shellAt).toBeGreaterThan(1_000);
    expect(document.html).toContain("hello <!-- -->ada");
    // Each request sends the stored shell's cached stamp.
    shellStamps.add(/<p id="shell-stamp">([^<]*)<\/p>/.exec(document.html)![1]);
    expect(document.html.match(/<html/g)).toHaveLength(1);
    expect(document.html.trimEnd().endsWith("</html>")).toBe(true);
  }
  expect(shellStamps.size).toBe(1);

  const after = await readServerWork(baseURL!);
  // Neither request rendered the shell again; both rendered their greeting.
  expect(after["shell-probe-ssr"] ?? 0).toBe(before["shell-probe-ssr"] ?? 0);
  expect((after.greeting ?? 0) - (before.greeting ?? 0)).toBe(2);
});

test("hydrates a resumed fallback shell", async ({ baseURL, context, page, consoleErrors }) => {
  await readStreamedDocument(new URL("/en/blog/warm", baseURL), []);
  await context.addCookies([{ name: "name", value: "ada", url: baseURL! }]);

  await page.goto("/en/blog/hydrated");
  await expect(page.locator("#slug")).toHaveText("hydrated");
  await expect(page.locator("#greeting")).toHaveText("hello ada");
  await expect(page.locator("#locale")).toHaveText("en");

  // The shell's client component is interactive once the page hydrates.
  await expect(page.locator("#shell-probe[data-hydrated]")).toBeVisible();
  await page.locator("#shell-probe").click();
  await expect(page.locator("#shell-probe")).toHaveText("shell clicks: 1");
  expect(consoleErrors).toEqual([]);
});

test("regenerates a stale shell from a fresh render", async ({ baseURL }) => {
  const url = new URL("/en/regenerated", baseURL);
  const pageStamp = (document: StreamedDocument) =>
    /<p id="page-stamp">([^<]*)<\/p>/.exec(document.html)?.[1];
  const initial = await readServerWork(baseURL!);
  await readStreamedDocument(url, []);
  // The first render produces the shell after it, without waiting for another
  // request, though its cookie read comes in a boundary after the shell. Each
  // renders the shell probe.
  await expect
    .poll(
      async () =>
        ((await readServerWork(baseURL!))["shell-probe-ssr"] ?? 0) -
        (initial["shell-probe-ssr"] ?? 0),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => (await fetch(url)).headers.get("x-nextjs-postponed"), { timeout: 15_000 })
    .toBe("1");
  const before = pageStamp(await readStreamedDocument(url, []));

  await fetch(new URL("/api/revalidate", baseURL), { method: "POST" });

  // The stale shell is sent while it regenerates. Like Next.js, the new shell
  // is rendered afresh, not resumed from the stale one.
  await expect
    .poll(
      async () => {
        const document = await readStreamedDocument(url, []);
        expect(document.headers.get("x-nextjs-postponed")).toBe("1");
        expect(document.html.match(/<html/g)).toHaveLength(1);
        expect(document.html.match(/id="page-stamp"/g)).toHaveLength(1);
        return pageStamp(document);
      },
      { timeout: 15_000 },
    )
    .not.toBe(before);
});

// A path with its own shell: one generateStaticParams produced, a route
// without fallback params, and a path whose root param wasn't generated. Next.js
// prerenders these, or renders an unknown one blocking; vinext renders the
// first request and produces the shell after it.
for (const path of ["/en/about", "/en/blog/known", "/fr/about", "/fr/blog/new"]) {
  test(`resumes ${path} from its own shell`, async ({ baseURL, context, page, consoleErrors }) => {
    const url = new URL(path, baseURL);
    await readStreamedDocument(url, []);
    // The shell is produced in the background after the first render.
    await expect
      .poll(async () => (await fetch(url)).headers.get("x-nextjs-postponed"), {
        timeout: 15_000,
      })
      .toBe("1");

    const before = await readServerWork(baseURL!);
    const document = await readStreamedDocument(url, ['id="shell-stamp"', '<p id="greeting">']);
    const after = await readServerWork(baseURL!);

    expect(document.headers.get("x-nextjs-postponed")).toBe("1");
    expect(
      document.markers['<p id="greeting">'] - document.markers['id="shell-stamp"'],
    ).toBeGreaterThan(1_000);
    expect(after["shell-probe-ssr"] ?? 0).toBe(before["shell-probe-ssr"] ?? 0);
    expect((after.greeting ?? 0) - (before.greeting ?? 0)).toBe(1);

    await context.addCookies([{ name: "name", value: "ada", url: baseURL! }]);
    await page.goto(path);
    await expect(page.locator("#greeting")).toHaveText("hello ada");
    await expect(page.locator("#shell-probe[data-hydrated]")).toBeVisible();
    await page.locator("#shell-probe").click();
    await expect(page.locator("#shell-probe")).toHaveText("shell clicks: 1");
    expect(consoleErrors).toEqual([]);
  });
}
