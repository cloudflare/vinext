import { expect, test } from '@playwright/test';
import { waitForError, waitForTransaction } from '@sentry-internal/test-utils';

test('Should capture errors for crashing streaming promises in server components when `Sentry.captureRequestError` is added to the `onRequestError` hook', async ({
  page,
}) => {
  const errorEventPromise = waitForError('nextjs-16-static', errorEvent => {
    return !!errorEvent?.exception?.values?.some(value => value.value === 'I am a data streaming error');
  });

  const serverTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /streaming-rsc-error/[param]';
  });

  // The streaming RSC error can interrupt the HTTP response, causing the navigation to reject
  // (e.g. net::ERR_ABORTED) even though the error and transaction are still captured.
  await page.goto(`/streaming-rsc-error/123`).catch(() => {});
  const errorEvent = await errorEventPromise;
  const serverTransactionEvent = await serverTransactionPromise;

  // error event is part of the transaction
  expect(errorEvent.contexts?.trace?.trace_id).toBe(serverTransactionEvent.contexts?.trace?.trace_id);

  expect(errorEvent.request).toMatchObject({
    headers: expect.any(Object),
    method: 'GET',
  });

  expect(errorEvent.contexts?.nextjs).toEqual({
    route_type: 'render',
    router_kind: 'App Router',
    router_path: '/streaming-rsc-error/[param]',
    request_path: '/streaming-rsc-error/123',
  });

  expect(errorEvent.exception?.values?.[0]?.mechanism).toEqual({
    handled: false,
    type: 'auto.function.nextjs.on_request_error',
  });
});
