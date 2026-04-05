// Full settings page -- rendered on direct navigation to /team/[teamId]/settings.
export default function SettingsPage({ params }: { params: { teamId: string } }) {
  return (
    <div data-testid="settings-page">
      <h1>Settings for Team {params.teamId}</h1>
      <p data-testid="settings-page-team-id">team-id:{params.teamId}</p>
    </div>
  );
}
