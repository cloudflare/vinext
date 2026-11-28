import { AlphaList } from "../../lib/panels/alpha-list";
import { BetaList } from "../../lib/panels/beta-list";

export default function PanelsBoth() {
  return (
    <main data-page="panels/both">
      <AlphaList />
      <BetaList />
    </main>
  );
}
