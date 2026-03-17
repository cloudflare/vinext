/**
 * Fixture for app-catch-all-optional test.
 * Ported from: test/e2e/app-dir/app-catch-all-optional/app/[lang]/[flags]/[[...rest]]/page.tsx
 *
 * Tests optional catch-all routing: /catch-all-optional/[lang]/[flags]/[[...rest]]
 */
export default async function Page({
  params,
}: {
  params: Promise<{ lang: string; flags: string; rest?: string[] }>;
}) {
  const { lang, flags, rest } = await params;

  return (
    <div>
      <div data-lang={lang}>{lang}</div>
      <div data-flags={flags}>{flags}</div>
      <div data-rest={rest?.join("/") ?? ""}>{rest?.join("/") ?? ""}</div>
    </div>
  );
}
