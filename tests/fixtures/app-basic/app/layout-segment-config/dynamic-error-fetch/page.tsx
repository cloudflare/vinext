export const dynamic = "error";

export default async function Page() {
  await fetch("data:text/plain,not-cacheable", { cache: "no-store" });
  return <p data-testid="layout-segment-config-dynamic-error-fetch">Should not render</p>;
}
