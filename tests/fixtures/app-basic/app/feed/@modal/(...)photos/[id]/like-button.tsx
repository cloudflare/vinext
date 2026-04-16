"use client";

import { useState } from "react";
import { bumpPhotoLikes } from "./actions";

export function LikeButton({ id, initialLikes }: { id: string; initialLikes: number }) {
  const [likes, setLikes] = useState(initialLikes);

  return (
    <div>
      <span data-testid="photo-likes">{likes}</span>
      <button
        data-testid="photo-like-btn"
        type="button"
        onClick={async () => {
          const next = await bumpPhotoLikes(id);
          setLikes(next);
        }}
      >
        Like
      </button>
    </div>
  );
}
