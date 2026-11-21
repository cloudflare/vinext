// Port of next-intl's examples/example-app-router/next.config.ts (v4.11.1).
// vinext: `experimental.messages` with `precompile: true` is added so the
// suite covers next-intl's catalog loader (cloudflare/vinext#4303).
import {NextConfig} from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin({
  experimental: {
    createMessagesDeclaration: './messages/en.json',
    messages: {
      path: './messages',
      locales: 'infer',
      format: 'json',
      precompile: true
    }
  }
});

const config: NextConfig = {};

export default withNextIntl(config);
