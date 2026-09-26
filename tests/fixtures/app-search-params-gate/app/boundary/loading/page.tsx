import { RenderId } from "../../fixture-parts";
import { SearchValue } from "../../search-value";

// Only loading.tsx wraps this useSearchParams().
export default function Page() {
  return (
    <main>
      <RenderId />
      <SearchValue />
    </main>
  );
}
