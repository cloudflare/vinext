import * as Sentry from "@sentry/nextjs";

export async function register() {
  Sentry.init({
    beforeSendTransaction(event) {
      // The transport posts to /api/1/envelope/, whose trailing-slash redirect
      // carries no request URL. Without the http.target fallback, every send
      // reports another redirect transaction, which is sent in turn, forever.
      const url = event.request?.url ?? event.contexts?.trace?.data?.["http.target"];
      if (typeof url !== "string") return event;

      const pathname = new URL(url, "http://localhost").pathname.replace(/\/$/, "");
      return pathname === "/api/sentry-test-state" || pathname.endsWith("/envelope") ? null : event;
    },
    dsn: process.env.NEXT_PUBLIC_VINEXT_TEST_SENTRY_DSN,
    // The Worker isolate outlives each test, so Dedupe would drop the identical
    // error a retried test throws again and the retry could never pass.
    integrations: (integrations) => integrations.filter(({ name }) => name !== "Dedupe"),
    tracesSampleRate: 1,
  });
}

export const onRequestError = Sentry.captureRequestError;
