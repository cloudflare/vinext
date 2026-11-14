import nextDynamic from "next/dynamic";

export const dynamic = "force-dynamic";

// Another route reaches the viewer through a dynamic import, which must not
// stop the routes importing it statically from linking its stylesheet.
const Viewer = nextDynamic(() => import("../viewer").then((mod) => mod.Viewer));

export default function LazyViewerPage() {
  return <Viewer />;
}
