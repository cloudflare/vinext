import Link from "next/link";
import { LayoutCounter } from "../components/layout-counter";
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
        <Link href="/dashboard" data-testid="dash-home-link">
          Dashboard Home
        </Link>
        <Link href="/dashboard/settings" data-testid="dash-settings-link">
          Settings
        </Link>
      </nav>
      <LayoutCounter />
      <SegmentDisplay />
      <section>{children}</section>
      {team && <aside data-testid="team-panel">{team}</aside>}
      {analytics && <aside data-testid="analytics-panel">{analytics}</aside>}
    </div>
  );
}
