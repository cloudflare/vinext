import { withSentryConfig } from '@sentry/nextjs/config';
import type { NextConfig } from 'next';

// Simulate Vercel environment for cron monitoring tests
process.env.VERCEL = '1';

const nextConfig: NextConfig = {
  experimental: {
    sri: {
      algorithm: 'sha256',
    },
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  applicationKey: 'nextjs-16-static-e2e',
  reactComponentAnnotation: {
    enabled: true,
  },
  _experimental: {
    vercelCronsMonitoring: true,
  },
});
