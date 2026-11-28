import { NorthSummary } from "../../lib/indexes/north-summary";
import { SouthSummary } from "../../lib/indexes/south-summary";

export default function IndexesBoth() {
  return (
    <main data-page="indexes/both">
      <NorthSummary />
      <SouthSummary />
    </main>
  );
}
