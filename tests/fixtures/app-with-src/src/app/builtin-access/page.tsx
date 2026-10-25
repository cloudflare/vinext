import Link from "next/link";

// No forbidden.tsx or unauthorized.tsx exists in this app, so these routes
// render Next.js's built-in 403 and 401 pages.
export default function BuiltinAccessPage() {
  return (
    <>
      <h1 id="builtin-access-home">Built-in access pages</h1>
      <Link id="navigate-forbidden" href="/builtin-access/forbidden">
        forbidden page
      </Link>
      <Link id="navigate-unauthorized" href="/builtin-access/unauthorized">
        unauthorized page
      </Link>
      <Link id="navigate-client-forbidden" href="/builtin-access/client-forbidden">
        forbidden client page
      </Link>
      <Link id="navigate-layout-forbidden" href="/builtin-access/layout-forbidden">
        forbidden layout
      </Link>
      <Link id="navigate-group-forbidden" href="/group-dynamic/403">
        forbidden group page
      </Link>
      <Link id="navigate-group-unauthorized" href="/group-dynamic/401">
        unauthorized group page
      </Link>
    </>
  );
}
