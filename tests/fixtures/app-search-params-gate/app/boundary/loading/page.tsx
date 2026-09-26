import { SearchValue } from "../../search-value";

// Only loading.tsx wraps this useSearchParams().
export default function Page() {
  return (
    <main>
      <SearchValue />
    </main>
  );
}
