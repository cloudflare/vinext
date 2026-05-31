"use client";

import { useState } from "react";

export function FeedState({ initialTab }: { initialTab: string }) {
  const [draft, setDraft] = useState("");
  const [tab] = useState(initialTab);

  return (
    <div>
      <p data-testid="feed-tab-state">tab:{tab}</p>
      <input
        aria-label="Feed draft"
        data-testid="feed-draft-input"
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
        value={draft}
      />
    </div>
  );
}
