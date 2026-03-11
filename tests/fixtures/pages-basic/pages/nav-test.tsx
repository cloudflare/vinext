import Router, { useRouter } from "next/router";
import Link from "next/link";

export default function NavTestPage() {
  const router = useRouter();
  return (
    <div>
      <h1>Navigation Test</h1>
      <p data-testid="pathname">Current: {router.pathname}</p>
      <button data-testid="push-about" onClick={() => router.push("/about")}>
        Push to About
      </button>
      <button data-testid="replace-ssr" onClick={() => router.replace("/ssr")}>
        Replace to SSR
      </button>
      <button data-testid="push-counter" onClick={() => router.push("/counter")}>
        Push to Counter
      </button>
      <button
        data-testid="push-post-as-hook"
        onClick={() =>
          router.push(
            {
              pathname: "/posts/[id]",
              query: { id: "42", from: "hook" },
            },
            "/posts/42?from=hook",
          )
        }
      >
        Push masked Post via hook
      </button>
      <button
        data-testid="replace-post-as-singleton"
        onClick={() =>
          Router.replace(
            {
              pathname: "/posts/[id]",
              query: { id: "84", from: "singleton" },
            },
            "/posts/84?from=singleton",
          )
        }
      >
        Replace masked Post via singleton
      </button>
      <Link href="/" data-testid="link-home">
        Link to Home
      </Link>
      <Link href="/about" data-testid="link-about">
        Link to About
      </Link>
      <Link href="/ssr" data-testid="link-ssr">
        Link to SSR
      </Link>
    </div>
  );
}
