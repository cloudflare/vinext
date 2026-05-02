// Final destination for the router-push-pending redirect test.
// The #redirect-destination element signals that the navigation fully committed.
export default function RouterPushPendingDestinationPage() {
  return (
    <div>
      <p id="redirect-destination">Redirect destination</p>
    </div>
  );
}
