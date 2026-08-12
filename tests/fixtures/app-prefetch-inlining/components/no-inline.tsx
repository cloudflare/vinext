"use cache";

import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

// Matches the upstream prefetch-inlining fixture: produce at least 2 KiB of
// gzip-compressed output so build-time segment measurement must outline it.
export async function NoInline({ size = 2048 }: { size?: number }) {
  let content = "";
  let compressedLength = 0;
  let iterations = 0;
  while (compressedLength < size) {
    const chunk =
      iterations % 2 === 0
        ? "**Arbitrary hidden content to prevent this component from being inlined** "
        : `${randomBytes(128).toString("base64")} `;
    content += chunk;
    compressedLength = gzipSync(content).length;
    iterations++;
    if (iterations > 10_000) break;
  }
  return <div style={{ display: "none" }}>{content}</div>;
}
