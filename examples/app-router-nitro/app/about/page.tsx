import { headers, cookies } from "next/headers";
import Link from "next/link";
import type { Metadata } from "next";
import { addGuestbookEntry } from "../actions.js";
import { getGuestbookEntries } from "../_guestbook.js";
import { s } from "../_styles.js";

export const metadata: Metadata = {
  title: "About",
  description: "About page demonstrating next/headers and cookies",
};

export default async function AboutPage() {
  // next/headers — read request headers
  const h = await headers();
  const userAgent = h.get("user-agent") ?? "unknown";
  const acceptLanguage = h.get("accept-language") ?? "unknown";

  // next/headers — read cookies
  const c = await cookies();
  const theme = c.get("theme")?.value ?? "not set";
  const visitCount = c.get("visit-count")?.value ?? "0";

  const entries = getGuestbookEntries();

  return (
    <main style={s.page}>
      <div>
        <h1 style={s.title}>About</h1>
        <p style={s.subtitle}>
          This page demonstrates <code>headers()</code>,{" "}
          <code>cookies()</code>, and server actions.
        </p>
      </div>

      {/* Demonstrates headers() */}
      <section style={s.card}>
        <h2 style={s.label}>headers()</h2>
        <dl style={s.dl}>
          <dt style={s.dt}>User-Agent</dt>
          <dd data-testid="user-agent" style={s.dd}>
            {userAgent.slice(0, 80)}
          </dd>
          <dt style={s.dt}>Accept-Language</dt>
          <dd data-testid="accept-language" style={s.dd}>
            {acceptLanguage}
          </dd>
        </dl>
      </section>

      {/* Demonstrates cookies() */}
      <section style={s.card}>
        <h2 style={s.label}>cookies()</h2>
        <dl style={s.dl}>
          <dt style={s.dt}>Theme</dt>
          <dd data-testid="theme-cookie" style={s.dd}>
            {theme}
          </dd>
          <dt style={s.dt}>Visit Count</dt>
          <dd data-testid="visit-count" style={s.dd}>
            {visitCount}
          </dd>
        </dl>
      </section>

      {/* Server action — form with "use server" action */}
      <section style={s.card}>
        <h2 style={s.label}>Server Action</h2>
        <form
          action={addGuestbookEntry}
          style={{ display: "flex", gap: "0.5rem" }}
        >
          <input
            name="name"
            placeholder="Sign the guestbook..."
            required
            data-testid="guestbook-input"
            style={s.input}
          />
          <button type="submit" data-testid="guestbook-submit" style={s.btn}>
            Sign
          </button>
        </form>
        {entries.length > 0 && (
          <ul
            data-testid="guestbook-list"
            style={{ marginTop: "0.75rem", listStyle: "none", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
          >
            {entries.map((entry, i) => (
              <li key={i} style={s.tag}>
                {entry}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Link href="/">← Back to home</Link>
    </main>
  );
}
