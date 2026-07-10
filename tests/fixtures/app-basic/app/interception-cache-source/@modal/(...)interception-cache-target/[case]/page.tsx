export const revalidate = 1;

export default async function InterceptionCacheModalPage({
  params,
}: {
  params: { case: string } | Promise<{ case: string }>;
}) {
  const { case: testCase } = await params;
  return <div data-testid="interception-cache-modal">{`INTERCEPTED_MODAL:${testCase}`}</div>;
}
