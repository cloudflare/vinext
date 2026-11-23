import { BetaSection1 } from "./beta-section-1";
import { BetaSection2 } from "./beta-section-2";
import { BetaSection3 } from "./beta-section-3";
import { BetaSection4 } from "./beta-section-4";
import { BetaSection5 } from "./beta-section-5";
import { BetaSection6 } from "./beta-section-6";

// The beta list: 6 sections that are over 20 kB together.
export function BetaList() {
  return (
    <div data-marker="marker-beta-list">
      <BetaSection1 />
      <BetaSection2 />
      <BetaSection3 />
      <BetaSection4 />
      <BetaSection5 />
      <BetaSection6 />
    </div>
  );
}
