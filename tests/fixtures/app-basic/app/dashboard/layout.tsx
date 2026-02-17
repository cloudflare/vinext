import { SegmentDisplay } from "./segment-display";

export default function DashboardLayout({
  children,
  team,
  analytics,
}: {
  children: React.ReactNode;
  team?: React.ReactNode;
  analytics?: React.ReactNode;
}) {
  return (
    <div id="dashboard-layout">
      <nav>
        <span>Dashboard Nav</span>
      </nav>
      <SegmentDisplay />
      <section>{children}</section>
      {team && <aside data-testid="team-panel">{team}</aside>}
      {analytics && <aside data-testid="analytics-panel">{analytics}</aside>}
    </div>
  );
}
