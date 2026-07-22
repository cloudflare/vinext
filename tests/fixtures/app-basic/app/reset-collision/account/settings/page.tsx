import Link from "next/link";

export default function AccountSettingsCollisionPage() {
  return (
    <main>
      <h1 data-testid="account-settings-page">Account settings</h1>
      <Link data-testid="to-admin-settings" href="/reset-collision/admin/settings">
        Go to admin settings
      </Link>
    </main>
  );
}
