import { DeskLayout } from "@atlas/workbench/desk-layout";
import { workbenchServerProps } from "@atlas/workbench/page-data";

/** The hub links to every desk, so it prefetches every desk's chunks. */
const WorkbenchHub = () => (
  <DeskLayout desk="hub" title="Workbench">
    <p data-testid="workbench-hub">Pick a desk.</p>
  </DeskLayout>
);

export const getServerSideProps = workbenchServerProps("hub");

export default WorkbenchHub;
