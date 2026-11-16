import { GridTable } from "atlas-grid-kit";
import { ArrowGlyph, BoxGlyph } from "atlas-glyphs";

import { REGIONS } from "@atlas/workbench/data/region-table";
import { DeskLayout } from "@atlas/workbench/desk-layout";
import { ExportMenu } from "@atlas/workbench/export-menu";
import { formatCents } from "@atlas/workbench/format/currency";
import { formatMinutes } from "@atlas/workbench/format/durations";
import { workbenchServerProps } from "@atlas/workbench/page-data";
import { StatusPill } from "@atlas/workbench/status-pill";

import styles from "./desk.module.css";

const STOCK = REGIONS.slice(0, 4).map((region, index) => [
  region.code,
  `${(index + 1) * 40} units`,
  formatCents((index + 3) * 1999),
  formatMinutes(region.transitMinutes),
]);

const InventoryDesk = () => (
  <DeskLayout desk="inventory" title="Inventory">
    <div className={styles.columns}>
      <p>
        <BoxGlyph /> Stock by region <ArrowGlyph />
      </p>
      <GridTable
        testId="inventory-table"
        columns={["Region", "Stock", "Value", "Transit"]}
        rows={STOCK}
      />
    </div>
    <StatusPill label="inventory" />
    <ExportMenu rows={STOCK} />
  </DeskLayout>
);

export const getServerSideProps = workbenchServerProps("inventory");

export default InventoryDesk;
