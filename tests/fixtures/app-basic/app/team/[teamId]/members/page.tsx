// Source route page -- rendered on direct navigation to /team/[teamId]/members.
export default function MembersPage({ params }: { params: { teamId: string } }) {
  return (
    <div data-testid="members-page">
      <h1>Members of Team {params.teamId}</h1>
    </div>
  );
}
