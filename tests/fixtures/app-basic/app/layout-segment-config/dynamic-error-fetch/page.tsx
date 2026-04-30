export const dynamic = "error";

export default async function Page() {
  await fetch("https://example.com/not-cacheable", { cache: "no-store" });
  return <p data-testid="layout-segment-config-dynamic-error-fetch">Should not render</p>;
}
