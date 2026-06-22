/**
 * CLI command framework tests.
 *
 * Covers the spec-driven CLI framework under packages/vinext/src/cli/:
 *  - parseCommand: typed coercion (port/int/positiveInt/string/boolean),
 *    value validation (missing/empty/looks-like-a-flag), defaults, multiple,
 *    unknown-flag errors (and the per-command passthroughUnknown opt-in),
 *    positionals, and the auto-injected --help flag.
 *  - renderCommandHelp: help text generated from the same spec that drives
 *    parsing (single source of truth — no drift).
 *  - The real `dev`, `build`, `start`, and `init` command specs: parsing +
 *    help, end to end.
 *
 * These mirror the legacy tests/cli-args.test.ts cases so the new engine keeps
 * the same validation guarantees while sourcing help from the spec.
 */
import { describe, it, expect } from "vite-plus/test";
import { parseCommand, CliUsageError } from "../packages/vinext/src/cli/parse.js";
import { renderCommandHelp } from "../packages/vinext/src/cli/help.js";
import type { ArgSpec, CommandSpec } from "../packages/vinext/src/cli/types.js";
import { devCommand } from "../packages/vinext/src/cli/commands/dev.js";
import { buildCommand } from "../packages/vinext/src/cli/commands/build.js";
import { startCommand } from "../packages/vinext/src/cli/commands/start.js";
import { initCommand } from "../packages/vinext/src/cli/commands/init.js";

// A representative spec exercising every value kind.
const spec = {
  args: {
    port: { type: "port", short: "p", description: "Port" },
    hostname: { type: "string", short: "H", description: "Host" },
    verbose: { type: "boolean", description: "Verbose" },
    concurrency: { type: "positiveInt", description: "Concurrency" },
  },
} satisfies Pick<CommandSpec, "args">;

// ─── port: parsing ──────────────────────────────────────────────────────────

describe("parseCommand — port", () => {
  it("parses --port <value>", () => {
    expect(parseCommand(spec, ["--port", "4000"]).values).toMatchObject({ port: 4000 });
  });

  it("parses -p short form", () => {
    expect(parseCommand(spec, ["-p", "4000"]).values).toMatchObject({ port: 4000 });
  });

  it("parses --port=value", () => {
    expect(parseCommand(spec, ["--port=8080"]).values).toMatchObject({ port: 8080 });
  });

  it("parses port 0 and 65535 (bounds)", () => {
    expect(parseCommand(spec, ["--port", "0"]).values).toMatchObject({ port: 0 });
    expect(parseCommand(spec, ["--port", "65535"]).values).toMatchObject({ port: 65535 });
  });

  it("throws when --port has no value (end of args)", () => {
    expect(() => parseCommand(spec, ["--port"])).toThrow(
      "--port requires a value, but none was provided.",
    );
  });

  it("throws when -p has no value, using the typed short form", () => {
    expect(() => parseCommand(spec, ["-p"])).toThrow("-p requires a value, but none was provided.");
  });

  it("throws when --port value looks like another flag", () => {
    expect(() => parseCommand(spec, ["--port", "--hostname", "x"])).toThrow(
      '--port requires a value, but got "--hostname" which looks like another flag.',
    );
  });

  it("throws when -p value looks like another short flag", () => {
    expect(() => parseCommand(spec, ["-p", "-H", "x"])).toThrow(
      '-p requires a value, but got "-H" which looks like another flag.',
    );
  });

  it("throws for non-numeric port (short form keeps -p in message)", () => {
    expect(() => parseCommand(spec, ["-p", "abc"])).toThrow(
      '-p expects an integer, but got "abc".',
    );
  });

  it("throws for trailing garbage (Number, not parseInt)", () => {
    expect(() => parseCommand(spec, ["--port", "4000abc"])).toThrow(
      '--port expects an integer, but got "4000abc".',
    );
  });

  it("throws for float port", () => {
    expect(() => parseCommand(spec, ["--port", "4000.5"])).toThrow(
      '--port expects an integer, but got "4000.5".',
    );
  });

  it("throws for out-of-range ports", () => {
    expect(() => parseCommand(spec, ["--port", "65536"])).toThrow(
      '--port expects a valid port (0-65535), but got "65536".',
    );
    expect(() => parseCommand(spec, ["--port=-1"])).toThrow(
      '--port expects a valid port (0-65535), but got "-1".',
    );
  });

  it("throws a CliUsageError instance", () => {
    expect(() => parseCommand(spec, ["--port"])).toThrow(CliUsageError);
  });
});

// ─── hostname / string ────────────────────────────────────────────────────────

describe("parseCommand — string", () => {
  it("parses a value (long, short, = forms)", () => {
    expect(parseCommand(spec, ["--hostname", "0.0.0.0"]).values).toMatchObject({
      hostname: "0.0.0.0",
    });
    expect(parseCommand(spec, ["-H", "localhost"]).values).toMatchObject({ hostname: "localhost" });
    expect(parseCommand(spec, ["--hostname=0.0.0.0"]).values).toMatchObject({
      hostname: "0.0.0.0",
    });
  });

  it("throws on missing/empty value", () => {
    expect(() => parseCommand(spec, ["--hostname"])).toThrow(
      "--hostname requires a value, but none was provided.",
    );
    expect(() => parseCommand(spec, ["--hostname="])).toThrow(
      "--hostname requires a value, but none was provided.",
    );
    expect(() => parseCommand(spec, ["--hostname", ""])).toThrow(
      "--hostname requires a value, but none was provided.",
    );
  });
});

// ─── positiveInt ──────────────────────────────────────────────────────────────

describe("parseCommand — positiveInt", () => {
  it("parses a positive integer", () => {
    expect(parseCommand(spec, ["--concurrency", "4"]).values).toMatchObject({ concurrency: 4 });
  });

  it("throws for zero and negatives", () => {
    expect(() => parseCommand(spec, ["--concurrency", "0"])).toThrow(
      '--concurrency expects a positive integer, but got "0".',
    );
    expect(() => parseCommand(spec, ["--concurrency", "4.5"])).toThrow(
      '--concurrency expects a positive integer, but got "4.5".',
    );
  });
});

// ─── booleans, defaults, multiple, unknowns, positionals ──────────────────────

describe("parseCommand — booleans", () => {
  it("is true when present, false when absent", () => {
    expect(parseCommand(spec, ["--verbose"]).values).toMatchObject({ verbose: true });
    expect(parseCommand(spec, []).values).toMatchObject({ verbose: false });
  });

  it("rejects an inline value on a boolean flag instead of silently dropping it", () => {
    // node:util (strict: false) stores `--verbose=true` as the *string* "true",
    // which would otherwise resolve to `false` — the opposite of what was typed.
    expect(() => parseCommand(spec, ["--verbose=true"])).toThrow(
      '--verbose does not take a value, but got "true".',
    );
    expect(() => parseCommand(spec, ["--verbose=false"])).toThrow("does not take a value");
    expect(() => parseCommand(spec, ["--verbose="])).toThrow("does not take a value");
  });
});

describe("parseCommand — defaults", () => {
  const withDefaults = {
    args: {
      port: { type: "port", description: "Port", default: 3000 },
      hostname: { type: "string", description: "Host", default: "localhost" },
    },
  } satisfies Pick<CommandSpec, "args">;

  it("applies defaults when flags are absent", () => {
    expect(parseCommand(withDefaults, []).values).toMatchObject({
      port: 3000,
      hostname: "localhost",
    });
  });

  it("overrides defaults when flags are present", () => {
    expect(parseCommand(withDefaults, ["--port", "5000"]).values).toMatchObject({ port: 5000 });
  });
});

describe("parseCommand — multiple", () => {
  const withMultiple = {
    args: { tag: { type: "string", multiple: true, description: "Tags" } },
  } satisfies Pick<CommandSpec, "args">;

  it("collects repeated flags into an array", () => {
    expect(parseCommand(withMultiple, ["--tag", "a", "--tag", "b"]).values).toMatchObject({
      tag: ["a", "b"],
    });
  });

  it("defaults to an empty array when absent", () => {
    expect(parseCommand(withMultiple, []).values.tag).toEqual([]);
  });
});

describe("parseCommand — unknown flags", () => {
  it("errors on an unknown long flag", () => {
    expect(() => parseCommand(spec, ["--unknown", "value"])).toThrow('Unknown option "--unknown".');
  });

  it("errors on an unknown short flag", () => {
    expect(() => parseCommand(spec, ["-z"])).toThrow('Unknown option "-z".');
  });

  it("throws a CliUsageError for unknown flags", () => {
    expect(() => parseCommand(spec, ["--nope"])).toThrow(CliUsageError);
  });

  it("ignores unknown flags when passthroughUnknown is set", () => {
    const lenient = { ...spec, passthroughUnknown: true };
    const result = parseCommand(lenient, ["--unknown", "value", "--port", "4000"]);
    expect(result.values).not.toHaveProperty("unknown");
    expect(result.values).toMatchObject({ port: 4000 });
  });
});

describe("parseCommand — positionals", () => {
  it("collects positionals", () => {
    expect(parseCommand(spec, ["apps/web"]).positionals).toEqual(["apps/web"]);
  });

  it("keeps positionals alongside flags without consuming flag values", () => {
    const result = parseCommand(spec, ["--port", "4000", "apps/web", "--verbose"]);
    expect(result.values).toMatchObject({ port: 4000, verbose: true });
    expect(result.positionals).toEqual(["apps/web"]);
  });
});

describe("parseCommand — help", () => {
  it("recognizes --help / -h even when not declared", () => {
    expect(parseCommand(spec, ["--help"]).values.help).toBe(true);
    expect(parseCommand(spec, ["-h"]).values.help).toBe(true);
    expect(parseCommand(spec, []).values.help).toBe(false);
  });
});

// ─── help rendering ───────────────────────────────────────────────────────────

describe("renderCommandHelp", () => {
  const demo: CommandSpec = {
    name: "demo",
    summary: "Demo command",
    description: "A longer description.",
    args: {
      port: {
        type: "port",
        short: "p",
        valueHint: "port",
        description: "Port to listen on",
        default: 3000,
      },
      flag: { type: "boolean", description: "A boolean flag" } satisfies ArgSpec,
    },
    examples: [{ command: "vinext demo", description: "Run the demo" }],
    run: () => {},
  };

  const help = renderCommandHelp(demo);

  it("renders title, usage, and description", () => {
    expect(help).toContain("vinext demo - Demo command");
    expect(help).toContain("Usage: vinext demo [options]");
    expect(help).toContain("A longer description.");
  });

  it("renders options with placeholders and defaults", () => {
    expect(help).toContain("-p, --port <port>");
    expect(help).toContain("Port to listen on");
    expect(help).toContain("(default: 3000)");
    expect(help).toContain("--flag");
    expect(help).toContain("A boolean flag");
  });

  it("always documents the injected --help flag", () => {
    expect(help).toContain("-h, --help");
    expect(help).toContain("Show this help");
  });

  it("renders examples", () => {
    expect(help).toContain("Examples:");
    expect(help).toContain("vinext demo");
    expect(help).toContain("Run the demo");
  });

  it("omits a value placeholder for boolean flags", () => {
    expect(help).not.toContain("--flag <");
  });

  it("hides flags marked hidden from the options list", () => {
    const withHidden: CommandSpec = {
      name: "demo",
      summary: "Demo",
      args: {
        shown: { type: "boolean", description: "Visible flag" },
        secret: { type: "boolean", hidden: true, description: "Hidden flag" },
      },
      run: () => {},
    };
    const rendered = renderCommandHelp(withHidden);
    expect(rendered).toContain("--shown");
    expect(rendered).not.toContain("--secret");
    expect(rendered).not.toContain("Hidden flag");
  });
});

// ─── real dev command ─────────────────────────────────────────────────────────

describe("devCommand", () => {
  it("parses port and hostname (long and short)", () => {
    expect(parseCommand(devCommand, ["-p", "4000", "-H", "0.0.0.0"]).values).toMatchObject({
      port: 4000,
      hostname: "0.0.0.0",
    });
  });

  it("applies dev defaults (port 3000, localhost, turbopack off)", () => {
    expect(parseCommand(devCommand, []).values).toMatchObject({
      port: 3000,
      hostname: "localhost",
      turbopack: false,
    });
  });

  it("accepts the hidden next-compat flags without erroring", () => {
    expect(() => parseCommand(devCommand, ["--turbopack", "--experimental-https"])).not.toThrow();
  });

  it("generates help documenting visible flags but hiding compat ones", () => {
    const help = renderCommandHelp(devCommand);
    expect(help).toContain("vinext dev - Start development server");
    expect(help).toContain("-p, --port <port>");
    expect(help).toContain("(default: 3000)");
    expect(help).toContain("-H, --hostname <host>");
    expect(help).toContain("(default: localhost)");
    expect(help).toContain("-h, --help");
    // turbopack / experimental-https are hidden no-ops — accepted but not shown.
    expect(help).not.toContain("--turbopack");
    expect(help).not.toContain("--experimental-https");
  });
});

// ─── build / start / init commands ────────────────────────────────────────────

describe("buildCommand", () => {
  it("parses build flags", () => {
    expect(
      parseCommand(buildCommand, ["--verbose", "--prerender-all", "--prerender-concurrency", "4"])
        .values,
    ).toMatchObject({
      verbose: true,
      "prerender-all": true,
      "prerender-concurrency": 4,
    });
  });

  it("defaults boolean flags to false", () => {
    expect(parseCommand(buildCommand, []).values).toMatchObject({
      verbose: false,
      "prerender-all": false,
      precompress: false,
    });
  });

  it("validates --prerender-concurrency as a positive integer", () => {
    expect(() => parseCommand(buildCommand, ["--prerender-concurrency", "0"])).toThrow(
      "positive integer",
    );
  });

  it("accepts the hidden --turbopack next-compat flag without erroring", () => {
    expect(() => parseCommand(buildCommand, ["--turbopack"])).not.toThrow();
  });

  it("generates help from the spec", () => {
    const help = renderCommandHelp(buildCommand);
    expect(help).toContain("vinext build - Build for production");
    expect(help).toContain("--prerender-concurrency <count>");
    expect(help).toContain("--precompress");
    // turbopack is a hidden no-op — accepted but not shown.
    expect(help).not.toContain("--turbopack");
  });
});

describe("startCommand", () => {
  it("parses port/hostname and defaults hostname to 0.0.0.0", () => {
    expect(parseCommand(startCommand, ["-p", "8080"]).values).toMatchObject({
      port: 8080,
      hostname: "0.0.0.0",
    });
  });

  it("leaves port undefined when absent (run() applies the PORT-env fallback)", () => {
    expect(parseCommand(startCommand, []).values.port).toBeUndefined();
  });

  it("generates help from the spec", () => {
    const help = renderCommandHelp(startCommand);
    expect(help).toContain("vinext start - Start production server");
    expect(help).toContain("-p, --port <port>");
    expect(help).toContain("(default: 0.0.0.0)");
  });
});

describe("initCommand", () => {
  it("parses flags and defaults port to 3001", () => {
    expect(parseCommand(initCommand, ["--force", "--skip-check"]).values).toMatchObject({
      port: 3001,
      force: true,
      "skip-check": true,
    });
  });

  it("generates help with examples", () => {
    const help = renderCommandHelp(initCommand);
    expect(help).toContain("vinext init - Migrate a Next.js project to vinext");
    expect(help).toContain("--skip-check");
    expect(help).toContain("Examples:");
  });
});
