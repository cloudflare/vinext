import Script from "next/script";

/**
 * Layout used by `tests/script-head-ordering.test.ts` to verify that inline
 * `<Script strategy="beforeInteractive">` content is hoisted to the very top
 * of `<head>` — before any React-emitted resource hints (stylesheets,
 * modulepreload links, preload links).
 *
 * The script writes a marker on `self` so a browser-side test can confirm
 * the script ran. We deliberately don't touch `<html>` attributes here —
 * doing so would trip React's hydration warning unless the shared root
 * layout (used by every other test) opted into `suppressHydrationWarning`,
 * which it doesn't.
 */
export default function BeforeInteractiveHeadOrderingLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <Script
        id="vinext-test-theme-init"
        strategy="beforeInteractive"
        data-vinext-test="theme-init"
        dangerouslySetInnerHTML={{
          __html: `self.__vinextThemeInitRan = true;`,
        }}
      />
      {children}
    </>
  );
}
