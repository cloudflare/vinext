import Link from "next/link";

// Served in place of /gated-members/[id] to clients without the pass cookie.
// Used by E2E: app-router/interception-rewritten-source.spec.ts
export default function GatedLoginPage() {
  return (
    <div data-testid="gated-login-page">
      <h1>Log in</h1>
      <Link href="/photos/1" id="gated-login-photo-link">
        Photo 1
      </Link>
    </div>
  );
}
