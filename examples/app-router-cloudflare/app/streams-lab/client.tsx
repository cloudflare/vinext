"use client";

import { use, useEffect, useState } from "react";

export function StreamReader({ stream }: { stream: ReadableStream<string> }) {
  const [words, setWords] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const collected: string[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        collected.push(value);
      }
      if (!cancelled) setWords(collected);
    })();
    return () => {
      cancelled = true;
    };
  }, [stream]);
  return <p data-testid="stream-prop">{words ? words.join(" ") : "reading stream prop"}</p>;
}

export function UsePromise({ promise }: { promise: Promise<string> }) {
  return <p data-testid="use-promise">{use(promise)}</p>;
}
