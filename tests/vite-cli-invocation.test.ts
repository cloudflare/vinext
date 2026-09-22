import path from "node:path";
import { toSlash } from "pathslash";
import { describe, expect, it } from "vite-plus/test";
import {
  claimViteCliBuildInvocation,
  findViteRoot,
  getViteCliInvocation,
  isViteCliConfigFile,
  isViteCliInvocation,
} from "../packages/vinext/src/utils/vite-cli-invocation.js";

describe("findViteRoot", () => {
  it("does not guess a project root after an unknown valued option", () => {
    expect(findViteRoot("build", ["--bogus", "other", "project"])).toEqual({
      root: undefined,
      shouldPreflight: false,
    });
  });

  it.each([
    { args: ["--mode"] },
    { args: ["--mode="] },
    { args: ["--mode", "--config", "vite.config.ts"] },
  ])("leaves malformed required options to Vite ($args)", ({ args }) => {
    expect(findViteRoot("build", args)).toEqual({
      root: undefined,
      shouldPreflight: false,
    });
  });

  it("parses valid short option clusters without hiding help", () => {
    expect(findViteRoot("build", ["-dm", "staging", "project"])).toEqual({
      root: "project",
      shouldPreflight: true,
    });
    expect(findViteRoot("build", ["-hd", "project"])).toEqual({
      root: undefined,
      shouldPreflight: false,
    });
  });

  it("keeps the config preflight for version flags on explicit commands", () => {
    expect(findViteRoot("build", ["--version"])).toEqual({
      root: undefined,
      shouldPreflight: true,
    });
    expect(findViteRoot("dev", ["-v"])).toEqual({
      root: undefined,
      shouldPreflight: true,
    });
  });

  it("leaves required options before the end of a cluster to Vite", () => {
    expect(findViteRoot("build", ["-ml", "silent"])).toEqual({
      root: undefined,
      shouldPreflight: false,
    });
  });

  it("honors explicit global boolean values", () => {
    expect(findViteRoot("build", ["--help", "false", "project"])).toEqual({
      root: "project",
      shouldPreflight: true,
    });
    expect(findViteRoot("build", ["--help=true", "project"])).toEqual({
      root: "project",
      shouldPreflight: false,
    });
  });

  it.each(["--no-minify", "--no-sourcemap", "--no-manifest", "--no-base"])(
    "recognizes negated build option %s",
    (option) => {
      expect(findViteRoot("build", [option])).toEqual({
        root: undefined,
        shouldPreflight: true,
      });
    },
  );

  it.each(["--no-config", "--no-mode", "--no-target", "--no-configLoader"])(
    "defers malformed required-option negation %s to Vite",
    (option) => {
      expect(findViteRoot("build", [option])).toEqual({
        root: undefined,
        shouldPreflight: false,
      });
    },
  );

  it("leaves valued negations and extra positional roots to Vite", () => {
    expect(findViteRoot("build", ["--no-minify=false"])).toEqual({
      root: undefined,
      shouldPreflight: false,
    });
    expect(findViteRoot("build", ["first", "second"])).toEqual({
      root: "first",
      shouldPreflight: false,
    });
  });
});

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
    [["node", "/project/node_modules/vite/bin/vite.js", "-dm", "staging", "build"], "build", true],
    [["node", "/project/node_modules/vite/bin/vite.js", "--", "build"], "dev", true],
    [["node", "/project/node_modules/.bin/vp", "build"], "build", true],
    [["node", "/project/node_modules/.bin/vp", "-C", "apps/web", "dev"], "dev", true],
    [["node", "/project/node_modules/.bin/vp", "exec", "vite", "dev"], "dev", true],
    [["node", "/project/node_modules/vite/bin/vite.js", "preview"], "dev", false],
    [["node", "/project/node_modules/.bin/vp", "preview"], "dev", false],
    [["node", "/project/node_modules/.bin/vp", "test"], "build", false],
    [["node", "/project/test.ts", "build"], "build", false],
  ] as const)("classifies %j for %s", (argv, command, expected) => {
    expect(isViteCliInvocation(command, [...argv])).toBe(expected);
  });

  it("lets only the top-level Vite build claim the application lifecycle", () => {
    const argv = ["node", "/project/node_modules/vite/bin/vite.js", "build"];

    expect(claimViteCliBuildInvocation(argv)).toBe(true);
    expect(claimViteCliBuildInvocation(argv)).toBe(false);
  });

  it("resolves build roots and modes without consuming optional flags", () => {
    expect(
      getViteCliInvocation([
        "node",
        "/project/node_modules/vite/bin/vite.js",
        "--profile",
        "--mode",
        "staging",
        "build",
        "app",
      ]),
    ).toEqual({
      command: "build",
      mode: "staging",
      root: expect.stringMatching(/\/app$/),
      rootArg: "app",
    });
  });

  it("resolves modes from clustered short options", () => {
    expect(
      getViteCliInvocation([
        "node",
        "/project/node_modules/vite/bin/vite.js",
        "-dm",
        "staging",
        "build",
        "app",
      ]),
    ).toEqual({
      command: "build",
      mode: "staging",
      root: expect.stringMatching(/\/app$/),
      rootArg: "app",
    });
    expect(
      getViteCliInvocation([
        "node",
        "/project/node_modules/vite/bin/vite.js",
        "build",
        "app",
        "-dm=staging",
      ]),
    ).toEqual({
      command: "build",
      mode: "staging",
      root: expect.stringMatching(/\/app$/),
      rootArg: "app",
    });
  });

  it("does not consume roots after boolean-final short option clusters", () => {
    expect(
      getViteCliInvocation(["node", "/project/node_modules/vite/bin/vite.js", "-dw", "app"]),
    ).toEqual({
      command: "dev",
      mode: "development",
      root: expect.stringMatching(/\/app$/),
      rootArg: "app",
    });
  });

  it("keeps the next positional argument after a negated option", () => {
    expect(
      getViteCliInvocation([
        "node",
        "/project/node_modules/vite/bin/vite.js",
        "build",
        "--no-watch",
        "false",
        "project",
      ]),
    ).toMatchObject({ command: "build", root: path.resolve("false"), rootArg: "false" });
  });

  it.each(["build", "dev"] as const)("resolves %s mode after the project root", (command) => {
    expect(
      getViteCliInvocation([
        "node",
        "/project/node_modules/vite/bin/vite.js",
        command,
        "app",
        "--mode",
        "staging",
      ]),
    ).toEqual({ command, mode: "staging", root: expect.stringMatching(/\/app$/), rootArg: "app" });
  });

  it("does not treat Vite preview as a dev invocation", () => {
    expect(
      getViteCliInvocation(["node", "/project/node_modules/vite/bin/vite.js", "preview"]),
    ).toBeUndefined();
  });

  it("does not use post-delimiter arguments as the default dev root", () => {
    const argv = ["node", "/project/node_modules/vite/bin/vite.js", "--", "build"];

    expect(isViteCliInvocation("build", argv)).toBe(false);
    expect(getViteCliInvocation(argv)).toEqual({
      command: "dev",
      mode: "development",
      root: toSlash(process.cwd()),
    });
  });

  it("does not parse option-looking positional arguments after the delimiter", () => {
    expect(
      getViteCliInvocation([
        "node",
        "/project/node_modules/vite/bin/vite.js",
        "--mode",
        "staging",
        "--",
        "--mode",
        "test",
      ]),
    ).toEqual({
      command: "dev",
      mode: "staging",
      root: toSlash(process.cwd()),
    });
  });

  it("identifies the CLI config rather than a nested server's config", () => {
    const originalArgv = process.argv;
    try {
      process.argv = ["node", "/project/node_modules/vite/bin/vite.js", "dev"];
      expect(isViteCliConfigFile(path.join(process.cwd(), "vite.config.ts"))).toBe(true);
      expect(isViteCliConfigFile(path.join(process.cwd(), "nested/vite.config.ts"))).toBe(false);
      expect(isViteCliConfigFile(path.join(process.cwd(), "alternate.config.ts"))).toBe(false);
      expect(
        isViteCliConfigFile(path.join(process.cwd(), "vite.config.ts"), {
          root: process.cwd(),
          configFile: "vite.config.ts",
        }),
      ).toBe(false);
      expect(isViteCliConfigFile(path.join(process.cwd(), "vite.config.ts"), {})).toBe(true);

      process.argv.push("--config", "config/vite.config.ts");
      expect(isViteCliConfigFile(path.join(process.cwd(), "config/vite.config.ts"))).toBe(true);
      expect(isViteCliConfigFile(path.join(process.cwd(), "vite.config.ts"))).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("matches each command's repeated config precedence", () => {
    for (const [command, expected] of [
      ["dev", "second.config.ts"],
      ["build", "first.config.ts"],
    ] as const) {
      const invocation = getViteCliInvocation([
        "node",
        "/project/node_modules/vite/bin/vite.js",
        command,
        "--config",
        "first.config.ts",
        "--config",
        "second.config.ts",
      ]);
      expect(invocation?.configFile).toBe(path.resolve(expected));
    }
  });
});
