import Link from "next/link";
import Router from "next/router";

// Launch page for the gSSP-redirect cancellation test. Offers two ways to
// trigger the navigation to /gssp-redirect (which redirects to
// /gssp-redirect-target via getServerSideProps): a Link click and a
// router.push, mirroring the upstream Next.js test that clicks a link to a
// page whose data request resolves to a redirect.

export default function GsspRedirectTestPage() {
  return (
    <div>
      <h1>gSSP Redirect Test</h1>
      <Link href="/gssp-redirect" data-testid="link-redirect">
        Go to redirect page (link)
      </Link>
      <button data-testid="push-redirect" onClick={() => Router.push("/gssp-redirect")}>
        Go to redirect page (push)
      </button>
    </div>
  );
}
