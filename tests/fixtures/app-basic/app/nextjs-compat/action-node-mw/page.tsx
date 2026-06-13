import { echoAction } from "./actions";

/**
 * Page for the node-runtime-middleware server-action regression test
 * (cloudflare/vinext#1480). The fixture middleware matches `/nextjs-compat/
 * action-node-mw`, reads the request body on POST (simulating a node-runtime
 * middleware that consumes the body), then falls through. The action POST to
 * this page must still be intercepted and executed.
 *
 * A bound `<form action>` is used so the action reference is registered and
 * its `$ACTION_ID_` is emitted into the HTML for the test to extract.
 */
export default function ActionNodeMiddlewarePage() {
  const bound = echoAction.bind(null, "hi");
  return (
    <main>
      <h1>Action Node Middleware Test</h1>
      <form action={bound}>
        <button id="submit" type="submit">
          Submit
        </button>
      </form>
    </main>
  );
}
