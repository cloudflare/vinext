import * as Sentry from '@sentry/nextjs';
// Regression guard for https://github.com/getsentry/sentry-javascript/issues/21317:
import { pinoIntegration } from '@sentry/nextjs';

void pinoIntegration;

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
