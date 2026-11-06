// Port of next-intl's examples/example-app-router-playground/next.config.mjs.
// The `createNextIntlPlugin` wrapper is kept on purpose so the fixture covers
// next-intl's recommended setup. Upstream's request config lives at
// src/i18n/request.tsx, which vinext also finds without the plugin; it is
// renamed here so the build depends on the plugin's `next-intl/config` alias.
// `@next/bundle-analyzer` is dropped (webpack-only tooling).
import createMDX from '@next/mdx';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin({
  requestConfig: './src/i18n/request-config.tsx',
  experimental: {
    createMessagesDeclaration: './messages/en.json'
  }
});
const withMdx = createMDX({});

/** @type {import('next').NextConfig} */
const nextConfig = {
  trailingSlash: process.env.NEXT_PUBLIC_USE_CASE === 'trailing-slash',
  basePath:
    process.env.NEXT_PUBLIC_USE_CASE === 'base-path' ? '/base/path' : undefined,
  pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx']
};

export default withNextIntl(withMdx(nextConfig));
