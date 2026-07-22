"use client";

import { useState } from "react";

type Result = {
  ok: boolean;
  message: string;
  detail?: string;
};

export function RevalidateControls({
  tag,
  path,
}: {
  tag: string;
  path: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function call(kind: "tag" | "path", value: string) {
    setBusy(kind);
    setResult(null);
    try {
      const url = kind === "tag" ? "/api/revalidate-tag" : "/api/revalidate-path";
      const body = kind === "tag" ? { tag: value } : { path: value };
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        revalidated?: boolean;
        error?: string;
        target?: string;
      };
      if (res.ok && payload.revalidated) {
        setResult({
          ok: true,
          message: `Revalidated ${kind}=${value}`,
          detail: `Inner cache cleared and ctx.cache.purge invoked for the matching Cache-Tag entries.`,
        });
      } else {
        setResult({
          ok: false,
          message: payload.error ?? `Revalidation failed (${res.status})`,
        });
      }
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" aria-label="Revalidation controls">
      <h2 style={{ marginTop: 0 }}>Invalidate this page</h2>
      <p style={{ marginTop: 0, color: "var(--muted)" }}>
        Calls into a server route handler that invokes <code>revalidateTag</code> /{" "}
        <code>revalidatePath</code>. vinext fans the call out to both the inner CacheHandler
        (KV / memory) and <code>ctx.cache.purge(...)</code> when the runtime exposes one on the
        request context.
      </p>
      <div className="controls">
        <button
          type="button"
          onClick={() => void call("tag", tag)}
          disabled={busy !== null}
        >
          {busy === "tag" ? "Purging tag…" : `revalidateTag("${tag}")`}
        </button>
        <button
          type="button"
          onClick={() => void call("path", path)}
          disabled={busy !== null}
        >
          {busy === "path" ? "Purging path…" : `revalidatePath("${path}")`}
        </button>
      </div>
      <p className="status" role="status">
        {result ? (
          <>
            <span style={{ color: result.ok ? "var(--good)" : "var(--bad)" }}>
              {result.message}
            </span>
            {result.detail ? <> — {result.detail}</> : null}
          </>
        ) : (
          <>&nbsp;</>
        )}
      </p>
    </section>
  );
}
