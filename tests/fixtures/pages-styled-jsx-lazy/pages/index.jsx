// styled-jsx is only reached through `next/dynamic`, so no module the server
// entry loads up front uses it. Next.js still collects these rules on the
// first render because every Pages render is wrapped in styled-jsx's registry.
import dynamic from "next/dynamic";

const LazyStyled = dynamic(() => import("../components/LazyStyled"));

export default function Page() {
  return (
    <main>
      <LazyStyled />
    </main>
  );
}
