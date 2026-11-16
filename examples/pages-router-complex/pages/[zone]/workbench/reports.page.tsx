import { lazy, Suspense } from "react";

import dynamic from "next/dynamic";

import { DeskLayout } from "@atlas/workbench/desk-layout";
import { workbenchServerProps } from "@atlas/workbench/page-data";

const TrendChart = dynamic(() => import("@atlas/workbench/reporting/trend-chart"));
const LiveTicker = dynamic(() => import("@atlas/workbench/reporting/live-ticker"), {
  ssr: false,
  loading: () => <p data-testid="live-ticker-loading">Connecting…</p>,
});
const BreakdownTable = lazy(() => import("@atlas/workbench/reporting/breakdown-table"));

const ReportsDesk = () => (
  <DeskLayout desk="reports" title="Reports">
    <TrendChart series={[12, 30, 18, 44, 26]} />
    <LiveTicker />
    <Suspense fallback={<p data-testid="breakdown-loading">Loading breakdown…</p>}>
      <BreakdownTable
        rows={[
          ["ledger", 42],
          ["dispatch", 17],
          ["roster", 29],
        ]}
      />
    </Suspense>
  </DeskLayout>
);

export const getServerSideProps = workbenchServerProps("reports");

export default ReportsDesk;
