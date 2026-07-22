import localFont from "next/font/local";

const testFont = localFont({
  src: "./font.woff2",
});

// Ported from Next.js: test/e2e/app-dir/app/app/script-nonce/with-next-font/page.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/app/script-nonce/with-next-font/page.js
export default function Page(): React.ReactElement {
  return (
    <p id="script-nonce-font" className={testFont.className}>
      script-nonce
    </p>
  );
}
