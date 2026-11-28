import { AlphaSection1 } from "./alpha-section-1";
import { AlphaSection2 } from "./alpha-section-2";
import { AlphaSection3 } from "./alpha-section-3";
import { AlphaSection4 } from "./alpha-section-4";
import { AlphaSection5 } from "./alpha-section-5";
import { AlphaSection6 } from "./alpha-section-6";

// The alpha list: 6 sections that are over 20 kB together.
export function AlphaList() {
  return (
    <div data-marker="marker-alpha-list">
      <AlphaSection1 />
      <AlphaSection2 />
      <AlphaSection3 />
      <AlphaSection4 />
      <AlphaSection5 />
      <AlphaSection6 />
    </div>
  );
}
