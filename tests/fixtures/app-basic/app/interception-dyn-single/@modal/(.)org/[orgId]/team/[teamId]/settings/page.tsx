export default async function SettingsModal({
  params,
}: {
  params: Promise<{ orgId: string; teamId: string }>;
}) {
  const { orgId, teamId } = await params;
  return (
    <div>
      Modal: Settings for Team {teamId} in Org {orgId}
    </div>
  );
}
