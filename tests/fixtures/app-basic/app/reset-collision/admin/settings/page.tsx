async function waitForAdminSettings() {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

export default async function AdminSettingsCollisionPage() {
  await waitForAdminSettings();

  return (
    <main>
      <h1 data-testid="admin-settings-page">Admin settings</h1>
    </main>
  );
}
