/**
 * Client component for SSE test page.
 * Separated from page.tsx to avoid "use client" at page level,
 * which can interfere with vinext's SSR of dynamic() client components.
 *
 * See: https://github.com/cloudflare/vinext/issues/75
 */
"use client";

import { useEffect, useState } from "react";

export default function SSEClient() {
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    const eventSource = new EventSource("/api/sse");

    eventSource.onmessage = (event) => {
      setMessages((prev) => [...prev, event.data]);
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => eventSource.close();
  }, []);

  return (
    <div data-testid="sse-test-page">
      <h1>SSE Test</h1>
      <div data-testid="messages">
        {messages.map((msg, i) => (
          <p key={i} data-testid={`message-${i}`}>
            Message {i}: {msg}
          </p>
        ))}
      </div>
    </div>
  );
}
