import { AtlasSection1 } from "./atlas-section-1";
import { AtlasSection2 } from "./atlas-section-2";
import { AtlasSection3 } from "./atlas-section-3";
import { AtlasSection4 } from "./atlas-section-4";
import { AtlasSection5 } from "./atlas-section-5";
import { AtlasSection6 } from "./atlas-section-6";

// The atlas list: 6 sections that are over 20 kB together.
export function AtlasList() {
  return (
    <div data-marker="marker-atlas-list">
      <AtlasSection1 />
      <AtlasSection2 />
      <AtlasSection3 />
      <AtlasSection4 />
      <AtlasSection5 />
      <AtlasSection6 />
    </div>
  );
}
