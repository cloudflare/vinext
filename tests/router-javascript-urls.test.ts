import { describe, it, expect } from "vite-plus/test";

// Ported from Next.js: test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
//
// Next.js blocks dangerous URI schemes in router.push/replace/prefetch with a
// thrown Error: "Next.js has blocked a javascript: URL as a security precaution."
// See: packages/next/src/client/components/app-router-instance.ts:343,400,440,458
//
// Vinext mirrors that behavior. The guard runs before any programmatic
// navigation kicks off, at the top of push/replace/prefetch. Even server-side
// calls throw, matching Next.js intent and giving SSR-safe regression coverage
// in node-based unit tests.
//
// Coverage split:
//   Ported from the Next.js E2E suite above: javascript: cases for
//     push/replace/prefetch plus the obfuscation variants that Next.js's
//     javascript-url.ts regex covers (uppercase, embedded tabs, leading
//     whitespace).
//   Vinext-only extensions: data: and vbscript: cases. Vinext intentionally
//     extends the dangerous-scheme block to those schemes via the shared
//     isDangerousScheme helper. Rationale and scope: shims/url-safety.ts:20-21.

const BLOCK_MESSAGE = "Next.js has blocked a javascript: URL as a security precaution.";

describe("App Router useRouter() blocks dangerous URI schemes", () => {
  it("router.push throws on javascript: URL", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.push("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.replace throws on javascript: URL", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.replace("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.prefetch throws on javascript: URL", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.prefetch("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on data: URL", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.push("data:text/html,<script>alert(1)</script>")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on vbscript: URL", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.push("vbscript:MsgBox(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on obfuscated javascript: URL with embedded tabs", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.push("java\tscript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on uppercase JAVASCRIPT: URL", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.push("JAVASCRIPT:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on leading-whitespace javascript: URL", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.push("   javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  // Safe URLs must not throw — guard must not over-block.
  it("router.push does not throw on a normal pathname", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.push("/safe")).not.toThrow();
  });

  it("router.replace does not throw on absolute https URL", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.replace("https://example.com/path")).not.toThrow();
  });

  it("router.prefetch does not throw on a normal pathname", async () => {
    const { useRouter } = await import("../packages/vinext/src/shims/navigation.js");
    const router = useRouter();
    expect(() => router.prefetch("/safe")).not.toThrow();
  });
});
