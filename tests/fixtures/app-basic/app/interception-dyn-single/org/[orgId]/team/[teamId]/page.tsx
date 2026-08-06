import Link from "next/link";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ orgId: string; teamId: string }>;
}) {
  const { orgId, teamId } = await params;
  return (
    <div>
      <div id="team-page">
        Team {teamId} in Org {orgId}
      </div>
      <Link
        href={`/interception-dyn-single/org/${orgId}/team/${teamId}/settings`}
        id="settings-link"
      >
        Settings
      </Link>
    </div>
  );
}
