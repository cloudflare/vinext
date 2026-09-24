// Ported from Next.js: test/e2e/app-dir/scss/with-styled-jsx/pages/index.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/with-styled-jsx/pages/index.js
export default function CssOrderPage() {
  return (
    <>
      <div className="my-text">This text should be green.</div>
      <style jsx global>{`
        .my-text {
          color: green;
        }
      `}</style>
    </>
  );
}
