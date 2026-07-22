"use client";

import Link from "next/link";

export default function PostsCollisionError({ error }: { error: Error; reset: () => void }) {
  return (
    <section data-testid="posts-error-boundary">
      <h1>Posts error boundary</h1>
      <p>{error.message}</p>
      <Link data-testid="to-photos-123" href="/reset-collision/photos/123">
        Go to photos 123
      </Link>
    </section>
  );
}
