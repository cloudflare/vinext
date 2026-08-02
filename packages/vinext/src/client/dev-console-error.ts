// Ported from Next.js's console interception + hydration recognition:
//   packages/next/src/client/lib/console.ts (formatConsoleArgs)
//   packages/next/src/next-devtools/shared/react-19-hydration-error.ts
//   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/lib/console.ts
//   https://github.com/vercel/next.js/blob/canary/packages/next/src/next-devtools/shared/react-19-hydration-error.ts

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

// Ported from Next.js's formatObject (client/lib/console.ts)
function formatObject(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    let result = "[";
    if (depth < 1) {
      for (let i = 0; i < value.length; i++) {
        if (result !== "[") result += ",";
        if (Object.prototype.hasOwnProperty.call(value, i)) {
          result += formatObject(value[i], depth + 1);
        }
      }
    } else if (value.length > 0) {
      result += "...";
    }
    return result + "]";
  }

  if (isError(value)) return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "function")
    return value.name ? `[Function: ${value.name}]` : "[Function]";
  if (typeof value === "symbol") return value.toString();
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") {
    const keys = Object.keys(value);
    let result = "{";
    if (depth < 1) {
      let appended = 0;
      for (const key of keys) {
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc || desc.get || desc.set) continue;
        if (appended > 0) result += ", ";
        const jsonKey = JSON.stringify(key);
        result += jsonKey === `"${key}"` ? `${key}: ` : `${jsonKey}: `;
        result += formatObject(desc.value, depth + 1);
        appended++;
      }
    } else if (keys.length > 0) {
      result += "...";
    }
    return result + "}";
  }
  return JSON.stringify(value);
}

// util.format-style substitution for the message the overlay displays. Handles
// %s/%d/%i/%f/%o/%O/%c/%% the same way the browser console does, then appends
// any trailing arguments. Mirrors Next.js formatConsoleArgs so React's variadic
// warnings (hydration diffs, component stacks) render intact.
export function formatConsoleArgs(args: readonly unknown[]): string {
  let template: string;
  let idx: number;
  if (typeof args[0] === "string") {
    template = args[0];
    idx = 1;
  } else {
    template = "";
    idx = 0;
  }

  let result = "";
  let startQuote = false;
  for (let i = 0; i < template.length; ++i) {
    const char = template[i];
    if (char !== "%" || i === template.length - 1 || idx >= args.length) {
      result += char;
      continue;
    }

    const code = template[++i];
    switch (code) {
      case "c": {
        // %c carries CSS styling; the console renders it, we can't. Wrap the
        // styled run in brackets so a replayed "[Server]" badge stays legible.
        result = startQuote ? `${result}]` : `[${result}`;
        startQuote = !startQuote;
        idx++;
        break;
      }
      case "O":
      case "o": {
        result += formatObject(args[idx++], 0);
        break;
      }
      case "d":
      case "i": {
        result += String(Number.parseInt(args[idx++] as string, 10));
        break;
      }
      case "f": {
        result += String(Number.parseFloat(args[idx++] as string));
        break;
      }
      case "s": {
        result += String(args[idx++]);
        break;
      }
      default:
        result += "%" + code;
    }
  }

  for (; idx < args.length; idx++) {
    result += (result.length > 0 ? " " : "") + formatObject(args[idx], 0);
  }

  return result;
}

// React calls user code starting from a special stack frame. StrictMode's
// double-invocation of the same throw produces two stacks that are identical
// below that frame and differ only above it (the extra invocation). Stripping
// everything from that frame down isolates the part unaffected by StrictMode,
// so two StrictMode-doubled reports of the same failure still compare equal.
// Ported verbatim from Next.js's REACT_ERROR_STACK_BOTTOM_FRAME_REGEX /
// getStackIgnoringStrictMode (next-devtools/dev-overlay/shared.ts).
const REACT_ERROR_STACK_BOTTOM_FRAME_REGEX =
  /\s+(at Object\.react_stack_bottom_frame.*)|(react_stack_bottom_frame@.*)|(at react-stack-bottom-frame.*)|(react-stack-bottom-frame@.*)/;

export function getStackIgnoringStrictMode(
  stack: string | undefined,
): string | undefined {
  return stack?.split(REACT_ERROR_STACK_BOTTOM_FRAME_REGEX)[0];
}

// Two reports count as the same failure only when message, stack, and owner
// stack all match, mirrors Next.js's pushErrorFilterDuplicates. Comparing
// message text alone conflates two different call sites that happen to log
// identical text; comparing stack alone would resurface the same failure as
// "new" on every StrictMode double-invocation.
export function isSameReportedError(
  a: {
    message: string;
    stack: string | undefined;
    ownerStack: string | null | undefined;
  },
  b: {
    message: string;
    stack: string | undefined;
    ownerStack: string | null | undefined;
  },
): boolean {
  if (a.message !== b.message) return false;
  if (
    a.stack !== b.stack &&
    getStackIgnoringStrictMode(a.stack) !== getStackIgnoringStrictMode(b.stack)
  ) {
    return false;
  }
  return a.ownerStack === b.ownerStack;
}

// The attribute-only hydration mismatch, regex ported from Next.js
// (react-19-hydration-error.ts's isHydrationError). React logs it to
// console.error and does NOT call onRecoverableError.
const HYDRATION_ATTRIBUTE_MISMATCH =
  /A tree hydrated but some attributes of the server rendered HTML didn't match the client properties\./;

export function isAttributeOnlyHydrationWarningMessage(
  message: string,
): boolean {
  return HYDRATION_ATTRIBUTE_MISMATCH.test(message);
}
