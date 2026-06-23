export default async function SettingsPage({
  params,
}: {
  params: Promise<{ orgId: string; teamId: string }>;
}) {
  const { orgId, teamId } = await params;
  return (
    <div>
      Settings for Team {teamId} in Org {orgId}
    </div>
  );
}
