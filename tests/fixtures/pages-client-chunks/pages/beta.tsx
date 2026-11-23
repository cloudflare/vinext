import { SharedPanel } from "../lib/shared-panel";
import { SharedTable } from "../lib/shared-table";
import { sharedLabel } from "../lib/shared-label";
import { kitBadge } from "../lib/kit";
import { BETA_ROWS } from "../lib/rows";

export default function Page() {
  return (
    <>
      <SharedPanel>{kitBadge(sharedLabel("beta"))}</SharedPanel>
      <SharedTable />
      <ul>{BETA_ROWS.length}</ul>
    </>
  );
}
