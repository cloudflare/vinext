/**
 * CLI argument parser tests.
 *
 * Tests the parseArgs function extracted from cli.ts, validating that:
 *  - Value-taking flags (`--port`, `--hostname`) error on missing values
 *  - Value-taking flags error when the next arg is another flag
 *  - `--port` uses strict integer parsing (Number, not parseInt) and range checks
 *  - `--flag=value` forms work correctly
 *  - Boolean flags work as expected
 *  - Both long and short forms (`--port`/`-p`, `--hostname`/`-H`) are handled
 */
import { describe, it, expect } from "vite-plus/test";
import { parseArgs } from "../packages/vinext/src/cli-args.js";

// ─── Boolean flags ──────────────────────────────────────────────────────────

describe("boolean flags", () => {
  it("sets help for --help", () => {
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
  });

  it("sets help for -h", () => {
    expect(parseArgs(["-h"])).toMatchObject({ help: true });
  });

  it("sets verbose", () => {
    expect(parseArgs(["--verbose"])).toMatchObject({ verbose: true });
  });

  it("sets turbopack", () => {
    expect(parseArgs(["--turbopack"])).toMatchObject({ turbopack: true });
  });

  it("sets experimental for --experimental-https", () => {
    expect(parseArgs(["--experimental-https"])).toMatchObject({ experimental: true });
  });

  it("sets prerenderAll for --prerender-all", () => {
    expect(parseArgs(["--prerender-all"])).toMatchObject({ prerenderAll: true });
  });

  it("sets precompress for --precompress", () => {
    expect(parseArgs(["--precompress"])).toMatchObject({ precompress: true });
  });
});

// ─── --port flag ────────────────────────────────────────────────────────────

describe("--port / -p", () => {
  it("parses a numeric port value", () => {
    expect(parseArgs(["--port", "4000"])).toMatchObject({ port: 4000 });
  });

  it("parses -p short form", () => {
    expect(parseArgs(["-p", "4000"])).toMatchObject({ port: 4000 });
  });

  it("parses --port=value form", () => {
    expect(parseArgs(["--port=8080"])).toMatchObject({ port: 8080 });
  });

  it("parses port zero", () => {
    expect(parseArgs(["--port", "0"])).toMatchObject({ port: 0 });
  });

  it("parses port 65535 (max valid)", () => {
    expect(parseArgs(["--port", "65535"])).toMatchObject({ port: 65535 });
  });

  // ─── Error: missing value ─────────────────────────────────────────────────

  it("throws when --port has no value (end of args)", () => {
    expect(() => parseArgs(["--port"])).toThrow("--port requires a value, but none was provided.");
  });

  it("throws when -p has no value (end of args)", () => {
    expect(() => parseArgs(["-p"])).toThrow("-p requires a value, but none was provided.");
  });

  it("throws when --port value is another flag", () => {
    expect(() => parseArgs(["--port", "--hostname", "0.0.0.0"])).toThrow(
      '--port requires a value, but got "--hostname" which looks like another flag.',
    );
  });

  it("throws when -p value is another flag", () => {
    expect(() => parseArgs(["-p", "-H", "0.0.0.0"])).toThrow(
      '-p requires a value, but got "-H" which looks like another flag.',
    );
  });

  // ─── Error: invalid value ─────────────────────────────────────────────────

  it("throws for non-numeric port", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow('--port expects an integer, but got "abc".');
  });

  it("throws for --port= with non-numeric value", () => {
    expect(() => parseArgs(["--port=abc"])).toThrow('--port expects an integer, but got "abc".');
  });

  it("throws for empty string port", () => {
    expect(() => parseArgs(["--port", ""])).toThrow(
      "--port requires a value, but none was provided.",
    );
  });

  it("throws for trailing garbage (Number is strict where parseInt is not)", () => {
    expect(() => parseArgs(["--port", "4000abc"])).toThrow(
      '--port expects an integer, but got "4000abc".',
    );
  });

  it("throws for float port", () => {
    expect(() => parseArgs(["--port", "4000.5"])).toThrow(
      '--port expects an integer, but got "4000.5".',
    );
  });

  // ─── Error: out of range ──────────────────────────────────────────────────

  it("throws for negative port", () => {
    expect(() => parseArgs(["--port", "-1"])).toThrow(
      '--port expects a valid port (0-65535), but got "-1".',
    );
  });

  it("throws for port above 65535", () => {
    expect(() => parseArgs(["--port", "65536"])).toThrow(
      '--port expects a valid port (0-65535), but got "65536".',
    );
  });

  it("throws for --port= with negative value", () => {
    expect(() => parseArgs(["--port=-1"])).toThrow(
      '--port expects a valid port (0-65535), but got "-1".',
    );
  });
});

// ─── --hostname flag ────────────────────────────────────────────────────────

describe("--hostname / -H", () => {
  it("parses a hostname value", () => {
    expect(parseArgs(["--hostname", "0.0.0.0"])).toMatchObject({ hostname: "0.0.0.0" });
  });

  it("parses -H short form", () => {
    expect(parseArgs(["-H", "localhost"])).toMatchObject({ hostname: "localhost" });
  });

  it("parses --hostname=value form", () => {
    expect(parseArgs(["--hostname=0.0.0.0"])).toMatchObject({ hostname: "0.0.0.0" });
  });

  // ─── Error: missing value ─────────────────────────────────────────────────

  it("throws when --hostname has no value (end of args)", () => {
    expect(() => parseArgs(["--hostname"])).toThrow(
      "--hostname requires a value, but none was provided.",
    );
  });

  it("throws when -H has no value (end of args)", () => {
    expect(() => parseArgs(["-H"])).toThrow("-H requires a value, but none was provided.");
  });

  it("throws when --hostname value is another flag", () => {
    expect(() => parseArgs(["--hostname", "--port", "3000"])).toThrow(
      '--hostname requires a value, but got "--port" which looks like another flag.',
    );
  });

  it("throws when --hostname value is a short flag", () => {
    expect(() => parseArgs(["--hostname", "-p"])).toThrow(
      '--hostname requires a value, but got "-p" which looks like another flag.',
    );
  });

  it("throws when --hostname= has empty value", () => {
    expect(() => parseArgs(["--hostname="])).toThrow(
      "--hostname requires a value, but none was provided.",
    );
  });

  it("throws when --hostname value is empty string (space-separated)", () => {
    expect(() => parseArgs(["--hostname", ""])).toThrow(
      "--hostname requires a value, but none was provided.",
    );
  });

  it("throws when -H value is empty string", () => {
    expect(() => parseArgs(["-H", ""])).toThrow("-H requires a value, but none was provided.");
  });
});

// ─── Combined flags ─────────────────────────────────────────────────────────

describe("combined flags", () => {
  it("parses port and hostname together", () => {
    expect(parseArgs(["--port", "4000", "--hostname", "0.0.0.0"])).toMatchObject({
      port: 4000,
      hostname: "0.0.0.0",
    });
  });

  it("parses short forms together", () => {
    expect(parseArgs(["-p", "4000", "-H", "localhost"])).toMatchObject({
      port: 4000,
      hostname: "localhost",
    });
  });

  it("parses =value forms together", () => {
    expect(parseArgs(["--port=4000", "--hostname=0.0.0.0"])).toMatchObject({
      port: 4000,
      hostname: "0.0.0.0",
    });
  });

  it("parses boolean flags alongside value flags", () => {
    expect(parseArgs(["--verbose", "--port", "4000", "--hostname", "localhost"])).toMatchObject({
      verbose: true,
      port: 4000,
      hostname: "localhost",
    });
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("returns empty object for empty args", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("skips duplicate --port (last wins)", () => {
    expect(parseArgs(["--port", "3000", "--port", "4000"])).toMatchObject({ port: 4000 });
  });

  it("skips unrecognized flags", () => {
    const result = parseArgs(["--unknown", "value"]);
    expect(result).not.toHaveProperty("unknown");
    expect(result).not.toHaveProperty("port");
    expect(result).not.toHaveProperty("hostname");
  });
});
