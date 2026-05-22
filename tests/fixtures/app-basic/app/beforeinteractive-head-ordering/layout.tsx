import Script from "next/script";

/**
 * Layout used by `tests/script-head-ordering.test.ts` to verify that inline
 * `<Script strategy="beforeInteractive">` content is hoisted to the very top
 * of `<head>` — before any React-emitted resource hints (stylesheets,
 * modulepreload links, preload links).
 *
 * The script writes to a dataset attribute on `<html>` so a browser-side
 * test (or a simple HTML grep) can both confirm presence and prove that it
 * runs before stylesheets parse.
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
