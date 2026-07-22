import Link from "next/link";

export default function DashboardPage() {
  return (
    <div>
      <h1>Dashboard</h1>
      <p>Welcome to your dashboard.</p>
      <Link href="/dashboard?tab=settings" data-testid="dash-tab-link">
        Settings Tab
      </Link>
    </div>
  );
}
