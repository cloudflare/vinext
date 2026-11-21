import { useState } from "react";

import { TruckGlyph } from "atlas-glyphs";

import { HUBS, regionsForHub } from "@atlas/workbench/data/region-table";
import { DeskLayout } from "@atlas/workbench/desk-layout";
import { ExportMenu } from "@atlas/workbench/export-menu";
import { FilterBar } from "@atlas/workbench/filter-bar";
import { formatMinutes } from "@atlas/workbench/format/durations";
import { workbenchServerProps } from "@atlas/workbench/page-data";
import { StatusPill } from "@atlas/workbench/status-pill";

const DispatchDesk = () => {
  const [hub, setHub] = useState(HUBS[0] ?? "");
  const regions = regionsForHub(hub).slice(0, 5);
  return (
    <DeskLayout desk="dispatch" title="Dispatch">
      <FilterBar options={HUBS} onChange={setHub} />
      <ul data-testid="dispatch-regions" data-hub={hub}>
        {regions.map((region) => (
          <li key={region.code}>
            <TruckGlyph /> {region.name} · {formatMinutes(region.transitMinutes)}
          </li>
        ))}
      </ul>
      <StatusPill label="dispatch" />
      <ExportMenu rows={regions.map((region) => [region.code, region.name])} />
    </DeskLayout>
  );
};

export const getServerSideProps = workbenchServerProps("dispatch");

export default DispatchDesk;
