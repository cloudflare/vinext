export const dynamic = "force-dynamic";

export default async function RefreshDuringNavigationSlowPage() {
  await new Promise((resolve) => {
    setTimeout(resolve, 1000);
  });

  return <h1 data-testid="slow-page">{Date.now()}</h1>;
}
