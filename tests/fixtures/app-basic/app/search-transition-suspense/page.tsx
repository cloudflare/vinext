import { ArchivedItems } from "./archived-items";
import { RefProbe } from "./ref-probe";
import { Tabs } from "./tabs";

export default async function SearchTransitionSuspensePage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const archived = (await searchParams).archived === "1";

  return (
    <main>
      <h1>Search transition Suspense</h1>
      <Tabs />
      <RefProbe />
      <p data-testid="search-transition-view">{archived ? "archived" : "active"}</p>
      {archived ? <ArchivedItems /> : <p>No archived items shown.</p>}
    </main>
  );
}
