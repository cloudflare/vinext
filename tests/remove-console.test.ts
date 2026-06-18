/**
 * Remove console tests — verifies `compiler.removeConsole` behavior.
 *
 * Mirrors Next.js SWC remove_console transform:
 * - `removeConsole: true` strips all `console.*` calls
 * - `removeConsole: { exclude: ["error"] }` strips all except excluded methods
 * - Preserves calls when `console` is shadowed by a local variable/param
 * - Preserves computed property access `console[prop]()`
 * - Only strips the global `console` object
 */
import { describe, it, expect } from "vite-plus/test";
import { removeConsoleCalls as _removeConsoleCallsImpl } from "../packages/vinext/src/plugins/remove-console.js";

// `removeConsoleCalls` returns `{ code, map }`; these tests assert on the
// transformed source, so unwrap to the code string (null is preserved).
const removeConsoleCalls = (
  code: string,
  config: Parameters<typeof _removeConsoleCallsImpl>[1],
): string | null => _removeConsoleCallsImpl(code, config)?.code ?? null;

describe("removeConsoleCalls", () => {
  it("returns null when code has no console calls", () => {
    const code = `
export default function Page() {
  return <div>Hello</div>;
}
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("returns null when removeConsole is disabled", () => {
    const code = `
console.log("hello");
export default function Page() { return null; }
`;
    expect(removeConsoleCalls(code, false)).toBeNull();
  });

  it("strips console.log from top level", () => {
    const code = `
console.log("hello world");
export default function Page() { return null; }
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.log");
    expect(result).toContain("export default function Page");
  });

  it("strips console.warn, console.info, console.debug", () => {
    const code = `
console.warn("warn");
console.info("info");
console.debug("debug");
export default function Page() { return null; }
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.warn");
    expect(result).not.toContain("console.info");
    expect(result).not.toContain("console.debug");
    expect(result).toContain("export default");
  });

  it("strips console.error when not excluded", () => {
    const code = `
console.error("error");
export default function Page() { return null; }
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.error");
  });

  it("preserves console.error when excluded", () => {
    const code = `
console.error("keep me");
console.log("remove me");
export default function Page() { return null; }
`;
    const result = removeConsoleCalls(code, { exclude: ["error"] });
    expect(result).not.toBeNull();
    expect(result).toContain('console.error("keep me")');
    expect(result).not.toContain("console.log");
  });

  it("preserves console.table and console.assert when excluded (case-insensitive)", () => {
    const code = `
console.table([1, 2]);
console.assert(false, "msg");
console.log("remove me");
`;
    const result = removeConsoleCalls(code, { exclude: ["TABLE", "assert"] });
    expect(result).not.toBeNull();
    expect(result).toContain("console.table");
    expect(result).toContain("console.assert");
    expect(result).not.toContain("console.log");
  });

  it("strips console calls inside function bodies", () => {
    const code = `
function greet(name) {
  console.log("Hello, " + name);
  return "Hello, " + name;
}
export default function Page() { return greet("world"); }
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.log");
    expect(result).toContain("function greet");
    expect(result).toContain('return "Hello, " + name');
  });

  it("strips console calls in if/else blocks", () => {
    const code = `
if (process.env.NODE_ENV === "development") {
  console.log("dev mode");
} else {
  console.warn("prod mode");
}
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.log");
    expect(result).not.toContain("console.warn");
  });

  it("strips chained console calls on same line", () => {
    const code = `
console.log("a"); console.log("b");
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.log");
  });

  it("preserves console calls when console is shadowed (local variable)", () => {
    const code = `
const console = { log: () => {} };
console.log("custom");
`;
    const result = removeConsoleCalls(code, true);
    expect(result).toBeNull();
  });

  it("preserves console calls when console is a function parameter", () => {
    const code = `
function foo(console) {
  console.log("param");
}
`;
    const result = removeConsoleCalls(code, true);
    expect(result).toBeNull();
  });

  it("preserves console calls when console is destructured", () => {
    const code = `
function foo({ console }) {
  console.log("destructured");
}
`;
    const result = removeConsoleCalls(code, true);
    expect(result).toBeNull();
  });

  it("preserves console with default in destructured param: ({ console = {} })", () => {
    const code = `
function foo({ console = {} }) {
  console.log("destructured-default");
}
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console as default-valued positional param: (console = {})", () => {
    const code = `
function foo(console = { log: () => {} }) {
  console.log("default-param");
}
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console bound as a rest param: (...console)", () => {
    const code = `
function foo(...console) {
  console.log("rest");
}
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console bound via array destructuring", () => {
    const code = `
const [console] = [{ log: () => {} }];
console.log("array-destructured");
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console bound via nested array destructuring", () => {
    const code = `
const [[console]] = [[{ log: () => {} }]];
console.log("nested-array-destructured");
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console bound via rest in array destructuring", () => {
    const code = `
const [, ...console] = [1, 2, 3];
console.log("rest-destructured");
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console when shadowed by a function declaration name", () => {
    const code = `
function console(...args) {}
console.log("function-decl-name");
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console when shadowed by a class declaration name", () => {
    const code = `
class console {}
console.log("class-decl-name");
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console inside a named FunctionExpression named console", () => {
    const code = `
const x = function console() {
  console.log("named-fn-expr");
};
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves console when shadowed by a CatchClause param", () => {
    const code = `
try { throw 0; } catch (console) {
  console.log("catch-param");
}
`;
    expect(removeConsoleCalls(code, true)).toBeNull();
  });

  it("preserves computed property access console[prop]()", () => {
    const code = `
const method = "log";
console[method]("computed");
`;
    const result = removeConsoleCalls(code, true);
    expect(result).toBeNull();
  });

  it("preserves calls on non-console objects", () => {
    const code = `
const logger = { log: (x) => x };
logger.log("not console");
`;
    const result = removeConsoleCalls(code, true);
    expect(result).toBeNull();
  });

  it("preserves console as an expression value (not a call)", () => {
    const code = `
const c = console;
`;
    const result = removeConsoleCalls(code, true);
    expect(result).toBeNull();
  });

  it("strips console.group and console.groupEnd", () => {
    const code = `
console.group("section");
console.log("inside");
console.groupEnd();
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.group");
    expect(result).not.toContain("console.groupEnd");
    expect(result).not.toContain("console.log");
  });

  it("handles console calls without arguments", () => {
    const code = `
console.log();
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.log");
  });

  it("handles console calls with complex arguments", () => {
    const code = `
console.log({ a: 1 }, [2, 3], () => 4);
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.log");
  });

  it("strips console inside nested callbacks", () => {
    const code = `
setTimeout(() => {
  console.log("delayed");
}, 100);
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).not.toContain("console.log");
  });

  it("preserves console.time/Console.timeEnd when excluded", () => {
    const code = `
console.time("timer");
doWork();
console.timeEnd("timer");
console.log("done");
`;
    const result = removeConsoleCalls(code, { exclude: ["time", "timeEnd"] });
    expect(result).not.toBeNull();
    expect(result).toContain('console.time("timer")');
    expect(result).toContain('console.timeEnd("timer")');
    expect(result).not.toContain("console.log");
  });

  it("strips console as function argument (replaces with void 0)", () => {
    const code = `
foo(console.warn("arg"));
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).toContain("foo(void 0)");
    expect(result).not.toContain("console.warn");
  });

  it("strips console in return statement (replaces with void 0)", () => {
    const code = `
function run() {
  return console.info("result");
}
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).toContain("return void 0");
    expect(result).not.toContain("console.info");
  });

  it("strips console in ternary branches (replaces with void 0)", () => {
    const code = `
const action = isDev ? console.log("dev") : console.warn("prod");
`;
    const result = removeConsoleCalls(code, true);
    expect(result).not.toBeNull();
    expect(result).toContain("isDev ? void 0 : void 0");
    expect(result).not.toContain("console.log");
    expect(result).not.toContain("console.warn");
  });
});
