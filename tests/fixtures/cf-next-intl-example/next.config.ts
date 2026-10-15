// Port of next-intl's examples/example-app-router/next.config.ts (v4.11.1).
import {NextConfig} from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin({
  experimental: {
    createMessagesDeclaration: './messages/en.json'
  }
});

const config: NextConfig = {};

export default withNextIntl(config);
