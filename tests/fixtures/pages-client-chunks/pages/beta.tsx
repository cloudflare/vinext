import { SharedPanel } from "../lib/shared-panel";
import { SharedTable } from "../lib/shared-table";
import { sharedLabel } from "../lib/shared-label";
import { kitBadge } from "../lib/kit";

export default function Page() {
  return (
    <>
      <SharedPanel>{kitBadge(sharedLabel("beta"))}</SharedPanel>
      <SharedTable />
    </>
  );
}
