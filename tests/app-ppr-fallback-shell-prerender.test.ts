/**
 * A cacheComponents fallback shell (`/en/blog/[slug]`) renders the static parts
 * of the page and leaves what waits on the missing param to its Suspense
 * fallback. Its HTML prerender aborts a task after it starts, so the SSR root
 * must render within that task.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";
import { createIsolatedFixture } from "./helpers.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-ppr-fallback-shell");
const NODE_MODULES_DIR = path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules");

// Whether Node runs a setImmediate before the abort timer depends on the phase
// of the event loop the prerender request is handled in. Replacing setImmediate
// with a timer makes the build schedule the way a runtime without setImmediate
// does, where a root rendered a task later always loses the race with the abort.
const TIMER_SCHEDULER = `data:text/javascript,${encodeURIComponent(
  "globalThis.setImmediate = (callback, ...args) => setTimeout(callback, 0, ...args);" +
    "globalThis.clearImmediate = clearTimeout;",
)}`;

it.each([
  { scheduler: "setImmediate", execArgv: [] },
  { scheduler: "a timer", execArgv: ["--import", TIMER_SCHEDULER] },
])(
  "prerenders the static shell of a cacheComponents fallback shell when tasks run on $scheduler",
  async ({ execArgv }) => {
    const root = await createIsolatedFixture(
      FIXTURE_DIR,
      "vinext-ppr-fallback-shell-",
      undefined,
      NODE_MODULES_DIR,
    );
    try {
      await execFileAsync(process.execPath, [...execArgv, CLI_PATH, "build"], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "production",
          NO_COLOR: "1",
        },
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const files = fs.readdirSync(root, { recursive: true }).map(String);
      const shellFile = files.find((file) => file.endsWith(path.join("en", "blog", "[slug].html")));
      expect(shellFile, files.filter((file) => file.includes("blog")).join("\n")).toBeDefined();
      const html = fs.readFileSync(path.join(root, shellFile!), "utf8");
      expect(html).toContain('<h1 id="shell">static shell</h1>');
      expect(html).toContain('<p id="slug-loading">loading</p>');
      expect(html).not.toContain('<p id="slug">');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
