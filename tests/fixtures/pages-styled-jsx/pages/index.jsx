// Ported from Next.js: test/e2e/streaming-ssr/streaming-ssr/pages/index.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr/streaming-ssr/pages/index.js
export default function StyledJsxStreamingPage() {
  return (
    <div>
      <style jsx>{`
        p {
          color: blue;
        }
      `}</style>
      <p id="styled-jsx-streaming">index</p>
    </div>
  );
}

export const config = { runtime: "experimental-edge" };
