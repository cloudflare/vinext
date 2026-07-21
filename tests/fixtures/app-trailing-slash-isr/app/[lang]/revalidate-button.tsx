"use client";

import { useState, useTransition } from "react";

export function RevalidateButton({ lang }: { lang: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  function handleRevalidate(withSlash: boolean) {
    startTransition(async () => {
      try {
        const data = await fetch(`/api/revalidate/?lang=${lang}&withSlash=${withSlash}`).then(
          (res) => res.json() as Promise<{ timestamp: string }>,
        );
        startTransition(() => {
          setResult(`Revalidated at: ${data.timestamp}`);
        });
      } catch (e) {
        startTransition(() => {
          setResult(`Error: ${String(e)}`);
        });
      }
    });
  }

  return (
    <div>
      <button
        onClick={() => handleRevalidate(true)}
        disabled={isPending}
        id="revalidate-button-with-slash"
      >
        {isPending ? "Revalidating..." : `Revalidate /${lang}/`}
      </button>
      <button
        onClick={() => handleRevalidate(false)}
        disabled={isPending}
        id="revalidate-button-no-slash"
      >
        {isPending ? "Revalidating..." : `Revalidate /${lang} (no slash)`}
      </button>
      {result && <pre id="revalidate-result">{result}</pre>}
    </div>
  );
}
