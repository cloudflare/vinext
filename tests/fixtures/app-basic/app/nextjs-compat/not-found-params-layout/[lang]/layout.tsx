/**
 * Test fixture for issue #346: renderHTTPAccessFallbackPage does not pass params to layouts.
 *
 * This layout destructures `lang` from `params`. When a 404 is triggered under
 * this route segment, `renderHTTPAccessFallbackPage` must pass `params` to this
 * layout — otherwise it crashes with:
 *   "Cannot destructure property 'lang' of '(intermediate value)' as it is undefined."
 */

export default async function LangLayout({
  params,
  children,
}: {
  params: Promise<{ lang: string }>;
  children: React.ReactNode;
}) {
  const { lang } = await params;

  return (
    <div id="not-found-params-layout-wrapper" data-lang={lang}>
      <p>lang: {lang}</p>
      {children}
    </div>
  );
}
