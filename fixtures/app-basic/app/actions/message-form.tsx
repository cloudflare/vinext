"use client";

import { useState, useTransition } from "react";
import { addMessage } from "./actions";

export function MessageForm() {
  const [result, setResult] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const response = await addMessage(formData);
      setResult(response);
    });
  }

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          name="message"
          data-testid="message-input"
          placeholder="Type a message..."
          defaultValue=""
        />
        <button type="submit" data-testid="send-btn" disabled={isPending}>
          {isPending ? "Sending..." : "Send"}
        </button>
      </form>
      {result && <p data-testid="message-result">{result}</p>}
    </div>
  );
}
