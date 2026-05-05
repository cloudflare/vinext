// Tests that params named then, catch, finally, and status work correctly.
// These names shadow Promise/React well-known properties, so the thenable
// wrapper must protect them until the params are awaited.
export default async function ParamsShadowPage({
  params,
}: {
  params: { then: string; catch: string; finally: string; status: string };
}) {
  const resolved = await params;
  return (
    <main>
      <h1>Params Shadow Test</h1>
      <p data-testid="then">{resolved.then}</p>
      <p data-testid="catch">{resolved.catch}</p>
      <p data-testid="finally">{resolved.finally}</p>
      <p data-testid="status">{resolved.status}</p>
      <p data-testid="is-thenable">{typeof params.then === "function" ? "yes" : "no"}</p>
    </main>
  );
}
