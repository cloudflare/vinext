import Link from "next/link";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function InterceptedForceDynamicPage() {
  const nextUrl = (await headers()).get("next-url") ?? "none";

  return (
    <aside>
      <h1>Force dynamic prefetch</h1>
      <p id="cdn-dynamic-next-url">Next URL: {nextUrl}</p>
      <Link id="cdn-dynamic-source-b-link" href="/force-dynamic-source-b" prefetch={false}>
        Source B
      </Link>
    </aside>
  );
}
