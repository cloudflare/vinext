"use client";

import { useState, useTransition } from "react";
import { incrementLikes } from "./actions";

export function LikeButton() {
  const [likes, setLikes] = useState(0);
  const [isPending, startTransition] = useTransition();

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
    </div>
  );
}
