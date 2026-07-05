import * as Sentry from "@sentry/nextjs";

export async function register() {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_VINEXT_TEST_SENTRY_DSN,
    tracesSampleRate: 0,
  });
}

export const onRequestError = Sentry.captureRequestError;
