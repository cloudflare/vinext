import { describe, expect, it } from "vite-plus/test";
import { isViteCliInvocation } from "../packages/vinext/src/utils/vite-cli-invocation.js";

describe("isViteCliInvocation", () => {
  it.each([
    [["node", "/project/node_modules/vite/bin/vite.js", "build"], "build", true],
    [["node", "/project/node_modules/vite/bin/vite.js", "./app"], "dev", true],
    [["node", "/project/node_modules/vite/node/cli.js", "dev"], "dev", true],
    [
      ["node", "/project/node_modules/vite-plus-core/dist/vite/node/cli.js", "build"],
      "build",
      true,
    ],
    [
      ["node", "/project/node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "build"],
      "build",
      true,
    ],
    [
      [
        "node",
        "/project/node_modules/vite/bin/vite.js",
        "--profile",
        "--mode",
        "production",
        "build",
      ],
      "build",
      true,
    ],
    [["node", "/project/node_modules/.bin/vp", "build"], "build", true],
    [["node", "/project/node_modules/.bin/vp", "-C", "apps/web", "dev"], "dev", true],
    [["node", "/project/node_modules/.bin/vp", "exec", "vite", "dev"], "dev", true],
    [["node", "/project/node_modules/.bin/vp", "preview"], "dev", false],
    [["node", "/project/node_modules/.bin/vp", "test"], "build", false],
    [["node", "/project/test.ts", "build"], "build", false],
  ] as const)("classifies %j for %s", (argv, command, expected) => {
    expect(isViteCliInvocation(command, [...argv])).toBe(expected);
  });
});
