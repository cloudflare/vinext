import type { NextConfig } from 'next';
import createMDX from '@next/mdx';
import { type CodeHikeConfig } from 'codehike/mdx';

const nextConfig: NextConfig = {
  cacheComponents: true,
  pageExtensions: ['js', 'jsx', 'mdx', 'ts', 'tsx'],
  experimental: {
    // Disabled due to font error that's causing them not to be loaded
    // correctly in the browser.
    // inlineCss: true,
    viewTransition: true,
    prerenderEarlyExit: false,
  },
};

const codeHikeConfig = {
  components: { code: 'MyCode', inlineCode: 'MyInlineCode' },
} satisfies CodeHikeConfig;

const withMDX = createMDX({
  options: {
    remarkPlugins: [['remark-codehike', codeHikeConfig]],
    recmaPlugins: [['recma-codehike', codeHikeConfig]],
  },
});

export default withMDX(nextConfig);
