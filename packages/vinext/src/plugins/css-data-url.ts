import { createHash } from "node:crypto";
import type { Plugin } from "vite";

const RESOLVED_PREFIX = "\0vinext:css-data-url:";

export function decodeCssDataUrl(id: string): string | null {
  if (!id.startsWith("data:text/css")) return null;

  const commaIndex = id.indexOf(",");
  if (commaIndex === -1) return null;

  const metadata = id.slice(0, commaIndex).toLowerCase();
  const payload = id.slice(commaIndex + 1);

  if (metadata.includes(";base64")) {
    return Buffer.from(payload, "base64").toString("utf8");
  }

  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function styleIdForCss(css: string): string {
  return `vinext-css-data-url-${createHash("sha256").update(css).digest("hex").slice(0, 16)}`;
}

export function createCssDataUrlPlugin(): Plugin {
  const styles = new Map<string, string>();

  return {
    name: "vinext:css-data-url",
    enforce: "pre",

    resolveId(source) {
      const css = decodeCssDataUrl(source);
      if (css === null) return null;

      const id = `${RESOLVED_PREFIX}${styleIdForCss(css)}`;
      styles.set(id, css);
      return id;
    },

    load(id) {
      const css = styles.get(id);
      if (css === undefined) return null;

      return [
        `const css = ${JSON.stringify(css)};`,
        `const id = ${JSON.stringify(styleIdForCss(css))};`,
        `if (typeof document !== "undefined" && !document.getElementById(id)) {`,
        `  const style = document.createElement("style");`,
        `  style.id = id;`,
        `  style.textContent = css;`,
        `  document.head.appendChild(style);`,
        `}`,
        `export default css;`,
      ].join("\n");
    },
  };
}
