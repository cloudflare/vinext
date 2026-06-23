"use client";

import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";

function LoadingIndicator({ id }: { id: string }) {
  const { pending } = useLinkStatus();
  return pending ? <span id={`${id}-loading`}>(Loading)</span> : null;
}

export default function NavBar() {
  const router = useRouter();

  return (
    <nav>
      <Link href="/nextjs-compat/use-link-status/post/1" prefetch={false} id="post-1-link">
        Post 1 <LoadingIndicator id="post-1" />
      </Link>
      <Link href="/nextjs-compat/use-link-status/post/2" prefetch={false} id="post-2-link">
        Post 2 <LoadingIndicator id="post-2" />
      </Link>
      <button
        id="router-push-2-btn"
        onClick={() => router.push("/nextjs-compat/use-link-status/post/2")}
      >
        Router push to post 2
      </button>
    </nav>
  );
}
