"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { incrementLikes } from "./actions";

export function LikeButton() {
  const [likes, setLikes] = useState(0);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleClick() {
    startTransition(async () => {
      const newCount = await incrementLikes();
      setLikes(newCount);
    });
  }

  return (
    <div>
      <p data-testid="likes">Likes: {likes}</p>
      <button data-testid="like-btn" onClick={handleClick} disabled={isPending}>
        {isPending ? "Liking..." : "Like"}
      </button>
      <button data-testid="refresh-during-action-btn" onClick={() => router.refresh()}>
        Refresh
      </button>
    </div>
  );
}
