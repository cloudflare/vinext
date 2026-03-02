import Link from "next/link";
import { s } from "./_styles.js";

export default function NotFound() {
  return (
    <main style={s.center}>
      <h1
        data-testid="not-found"
        style={{ fontSize: "3rem", fontWeight: 700, color: "var(--muted)" }}
      >
        404
      </h1>
      <p style={s.subtitle}>The page you are looking for does not exist.</p>
      <Link href="/" style={{ ...s.btn, textDecoration: "none" }}>
        Go back home
      </Link>
    </main>
  );
}
