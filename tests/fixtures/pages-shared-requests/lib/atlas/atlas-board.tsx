import { AtlasList } from "./atlas-list";
import { ATLAS_ROWS_1 } from "./atlas-rows-1";
import { ATLAS_ROWS_2 } from "./atlas-rows-2";
import { ATLAS_ROWS_3 } from "./atlas-rows-3";

// What both atlas pages render: three files of rows without CSS, and a list of
// six sections that each have a CSS module.
export function AtlasBoard() {
  return (
    <div data-marker="marker-atlas-board">
      <p>{ATLAS_ROWS_1.length + ATLAS_ROWS_2.length + ATLAS_ROWS_3.length}</p>
      <AtlasList />
    </div>
  );
}
