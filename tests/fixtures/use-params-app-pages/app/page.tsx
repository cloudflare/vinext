"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();
  return (
    <>
      <div>
        <Link href="/a" id="to-a">
          To /a
        </Link>
      </div>
      <div>
        <Link href="/a/b" id="to-a-b">
          To /a/b
        </Link>
      </div>
      <div>
        <Link href="/pages-dir/foobar" id="to-pages">
          To /pages-dir/foobar (Pages)
        </Link>
      </div>
      <div>
        <button
          type="button"
          id="router-push-pages"
          onClick={() => router.push("/pages-dir/foobar")}
        >
          router.push(/pages-dir/foobar)
        </button>
      </div>
      <div>
        <button
          type="button"
          id="router-prefetch-pages"
          onClick={() => router.prefetch("/pages-dir/foobar")}
        >
          router.prefetch(/pages-dir/foobar)
        </button>
      </div>
      <div>
        <Link href="/account/details" id="to-app-priority">
          To /account/details (App)
        </Link>
      </div>
      <div>
        <button
          type="button"
          id="router-push-app-priority"
          onClick={() => router.push("/account/details")}
        >
          router.push(/account/details)
        </button>
      </div>
    </>
  );
}
