// Intercepting route: renders when navigating from /team/[teamId]/members
// to /team/[teamId]/settings. Shows a modal version of settings.
// The teamId param must be the actual value from the URL, not the literal ":teamId".
export default function SettingsModal({ params }: { params: { teamId: string } }) {
  return (
    <div data-testid="settings-modal">
      <h2>Settings Modal</h2>
      <p data-testid="settings-modal-team-id">team-id:{params.teamId}</p>
    </div>
  );
}
