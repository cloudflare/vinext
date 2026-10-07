import { RenderId } from "../../../fixture-parts";
import { SearchValue } from "../../../search-value";

// No generateStaticParams: Next.js renders this route per request (ƒ).
export default function Page() {
  return (
    <main>
      <RenderId />
      <SearchValue />
    </main>
  );
}
