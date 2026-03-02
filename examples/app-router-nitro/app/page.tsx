import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import Form from "next/form";
import { connection } from "next/server";
import type { Metadata } from "next";
import { Counter } from "./components/counter.js";
import { s } from "./_styles.js";

// Static metadata (title uses template from layout)
export const metadata: Metadata = {
  title: "Home",
  description: "vinext + nitro home page showcasing many Next.js features",
};

export default async function HomePage() {
  // Force dynamic rendering
  await connection();

  return (
    <main style={s.page}>
      <div>
        <h1 style={s.title}>vinext + nitro</h1>
        <p style={s.subtitle}>Server-rendered by vinext and nitro.</p>
      </div>

      <p data-testid="timestamp" style={s.badge}>
        Rendered at: {new Date().toISOString()}
      </p>

      {/* next/image — remote image */}
      <div style={s.card}>
        <h2 style={s.label}>next/image</h2>
        <Image
          src="https://placehold.co/300x200/EEE/31343C?text=vinext"
          alt="vinext placeholder"
          width={300}
          height={200}
          loading="eager"
          style={{ borderRadius: "var(--radius)" }}
        />
      </div>

      {/* Client component with navigation hooks + dynamic import */}
      <div style={s.card}>
        <h2 style={s.label}>Interactive (client)</h2>
        <Counter />
      </div>

      {/* next/form — GET form with client-side navigation */}
      <div style={s.card}>
        <h2 style={s.label}>next/form</h2>
        <Form
          action="/"
          data-testid="search-form"
          style={{ display: "flex", gap: "0.5rem" }}
        >
          <input name="q" placeholder="Try searching..." style={s.input} />
          <button type="submit" style={s.btn}>
            Search
          </button>
        </Form>
      </div>

      {/* next/link — various link features */}
      <div style={s.card}>
        <h2 style={s.label}>next/link</h2>
        <ul style={{ listStyle: "none", display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <li>
            <Link href="/about">About</Link>
          </li>
          <li>
            <Link href="/blog/hello-world">Blog Post</Link>
          </li>
          <li>
            <Link href="/api/hello" prefetch={false}>
              API Route
            </Link>
          </li>
          <li>
            <Link
              href={{ pathname: "/blog/[slug]", query: { slug: "dynamic" } }}
            >
              Dynamic Link
            </Link>
          </li>
          <li>
            <Link href="/does-not-exist">404 Page</Link>
          </li>
        </ul>
      </div>

      {/* next/script — inline script */}
      <Script id="vinext-analytics" strategy="afterInteractive">
        {`console.log("[vinext] page loaded")`}
      </Script>
    </main>
  );
}
