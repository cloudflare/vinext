import nextDynamic from "next/dynamic";

export const dynamic = "force-dynamic";

// A Server Component call site: the preload links and the widget are both
// client references the SSR pass has to load on the first request.
const Widget = nextDynamic(() => import("./widget"));

export default function DynamicPage() {
  return (
    <main>
      <h1>dynamic</h1>
      <Widget />
    </main>
  );
}
