import Link from "next/link";
import { cookies } from "next/headers";

export default async function VaryCookiePage() {
  const viewer = (await cookies()).get("session")?.value ?? "anonymous";
  const renderId = crypto.randomUUID();

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      <h1>
        <code>/vary-cookie</code>
      </h1>
      <p className="tagline">
        <code>next.config.ts</code> gives this page a public CDN policy with{" "}
        <code>Vary: Cookie</code>, so each session is cached apart from every other.
      </p>
      <div className="timestamp" data-vary-cookie-viewer={viewer} data-render-id={renderId}>
        <p>
          Viewer: <code>{viewer}</code>
        </p>
        <p>
          Render ID: <code>{renderId}</code>
        </p>
      </div>
    </main>
  );
}
