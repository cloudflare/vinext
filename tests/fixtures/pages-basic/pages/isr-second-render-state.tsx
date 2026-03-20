import Head from "next/head";
// Internal test-only import — do not use in application code.
import { getRequestContext } from "vinext/unified-request-context";

interface ISRSecondRenderStateProps {
  timestamp: number;
}

export default function ISRSecondRenderStatePage({ timestamp }: ISRSecondRenderStateProps) {
  const ctx = getRequestContext();
  const headBefore = ctx.ssrHeadChildren.length;
  const privateCacheBefore = ctx._privateCache?.size ?? 0;
  const insertedHtmlBefore = ctx.serverInsertedHTMLCallbacks.length;

  if (ctx._privateCache === null) {
    ctx._privateCache = new Map();
  }
  ctx._privateCache.set("isr-second-render-state", timestamp);
  ctx.serverInsertedHTMLCallbacks.push(() => "<style data-isr-second-render-state></style>");

  return (
    <>
      <Head>
        <title>ISR Second Render State</title>
      </Head>
      <h1>ISR Second Render State</h1>
      <p data-testid="head-before">{headBefore}</p>
      <p data-testid="private-cache-before">{privateCacheBefore}</p>
      <p data-testid="inserted-html-before">{insertedHtmlBefore}</p>
      <p data-testid="timestamp">{timestamp}</p>
    </>
  );
}

export async function getStaticProps() {
  return {
    props: {
      timestamp: Date.now(),
    },
    revalidate: 1,
  };
}
