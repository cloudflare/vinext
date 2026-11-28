import { SharedPanel } from "../lib/shared-panel";
import { SharedTable } from "../lib/shared-table";
import { sharedLabel } from "../lib/shared-label";
import { kitBadge } from "../lib/kit";
import { TALL_ROWS, WIDE_ROWS } from "../lib/rows";
import { BETA_NOTES } from "../lib/notes";

export default function Page() {
  return (
    <>
      <SharedPanel>{kitBadge(sharedLabel("beta"))}</SharedPanel>
      <SharedTable />
      <ul>{WIDE_ROWS.length + TALL_ROWS.length + BETA_NOTES.length}</ul>
    </>
  );
}
