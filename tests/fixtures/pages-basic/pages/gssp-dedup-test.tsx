import Router from "next/router";

const COUNTER_KEY = Symbol.for("vinext.tests.gsspDedupCounter");

export default function GsspDedupTest() {
  return (
    <main>
      <h1>gSSP Dedup Test</h1>
      <button
        data-testid="push-identical"
        onClick={() => {
          void Promise.all([
            Router.push("/gssp-dedup-slow?key=same"),
            Router.push("/gssp-dedup-slow?key=same"),
            Router.push("/gssp-dedup-slow?key=same"),
            Router.push("/gssp-dedup-slow?key=same"),
          ]);
        }}
      >
        Push identical
      </button>
      <button
        data-testid="push-cancelled"
        onClick={() => {
          void Router.push("/gssp-dedup-slow?key=cancelled");
          void Router.push("/gssp-redirect-target");
        }}
      >
        Cancel slow request
      </button>
      <button
        data-testid="push-distinct-query"
        onClick={() => {
          void Router.push("/gssp-dedup-slow?key=query-one");
          void Router.push("/gssp-dedup-slow?key=query-two");
        }}
      >
        Push distinct queries
      </button>
    </main>
  );
}

export function getServerSideProps() {
  (globalThis as typeof globalThis & { [COUNTER_KEY]?: number })[COUNTER_KEY] = 0;
  return { props: {} };
}
