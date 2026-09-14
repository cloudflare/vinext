import * as Sentry from "@sentry/nextjs";

export async function register() {
  Sentry.init({
    beforeSendTransaction(event) {
      const url = event.request?.url;
      if (!url) return event;

      const pathname = new URL(url, "http://localhost").pathname.replace(/\/$/, "");
      return pathname === "/api/sentry-test-state" || pathname.endsWith("/envelope") ? null : event;
    },
    dsn: process.env.NEXT_PUBLIC_VINEXT_TEST_SENTRY_DSN,
    tracesSampleRate: 1,
  });
}

export const onRequestError = Sentry.captureRequestError;
