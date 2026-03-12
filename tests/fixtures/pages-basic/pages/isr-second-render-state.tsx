import Head from "next/head";
import { getRequestContext } from "vinext/unified-request-context";

interface ISRSecondRenderStateProps {
  timestamp: number;
}

export default function ISRSecondRenderStatePage({ timestamp }: ISRSecondRenderStateProps) {
  const ctx = getRequestContext();
  const headBefore = ctx.ssrHeadElements.length;
  const privateCacheBefore = ctx._privateCache?.size ?? 0;

  if (ctx._privateCache === null) {
    ctx._privateCache = new Map();
  }
  ctx._privateCache.set("isr-second-render-state", timestamp);

  return (
    <>
      <Head>
        <title>ISR Second Render State</title>
      </Head>
      <h1>ISR Second Render State</h1>
      <p data-testid="head-before">{headBefore}</p>
      <p data-testid="private-cache-before">{privateCacheBefore}</p>
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
