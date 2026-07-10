export const revalidate = 1;

export default async function InterceptionCacheTargetPage({
  params,
}: {
  params: { case: string } | Promise<{ case: string }>;
}) {
  const { case: testCase } = await params;
  return <main data-testid="interception-cache-full-page">{`FULL_PAGE:${testCase}`}</main>;
}
