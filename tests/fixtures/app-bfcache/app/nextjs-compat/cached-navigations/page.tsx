import Link from "next/link";
import { GestureShellButton } from "./gesture-shell-button";

const BASE = "/nextjs-compat/cached-navigations";

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <h2>
        Links with <code>prefetch=false</code>
      </h2>
      <ul>
        <li>
          <Link href={`${BASE}/partially-static`} prefetch={false}>
            Go to partially static page
          </Link>
        </li>
        <li>
          <Link href={`${BASE}/fully-static`} prefetch={false}>
            Go to fully static page
          </Link>
        </li>
        <li>
          <Link href={`${BASE}/with-static-params/foo`} prefetch={false}>
            Go to page with static params
          </Link>
        </li>
        <li>
          <Link href={`${BASE}/with-fallback-params/foo`} prefetch={false}>
            Go to page with fallback params
          </Link>
        </li>
        <li>
          <Link href={`${BASE}/with-partial-static-params/en/foo`} prefetch={false}>
            Go to page with partial static params
          </Link>
        </li>
        <li>
          <Link href={`${BASE}/runtime-prefetchable`} prefetch={false}>
            Go to runtime-prefetchable page
          </Link>
        </li>
      </ul>
      <GestureShellButton href={`${BASE}/partially-static`} />
    </main>
  );
}
