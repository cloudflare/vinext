import { expect, test } from '@playwright/test';
import { waitForError, waitForTransaction } from '@sentry-internal/test-utils';

test('Should capture errors from nested server components when `Sentry.captureRequestError` is added to the `onRequestError` hook', async ({
  page,
}) => {
  const errorEventPromise = waitForError('nextjs-16-static', errorEvent => {
    return !!errorEvent?.exception?.values?.some(value => value.value === 'I am technically uncatchable');
  });

  const serverTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /nested-rsc-error/[param]';
  });

  await page.goto(`/nested-rsc-error/123`);
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
    router_path: '/nested-rsc-error/[param]',
    request_path: '/nested-rsc-error/123',
  });

  expect(errorEvent.exception?.values?.[0]?.mechanism).toEqual({
    handled: false,
    type: 'auto.function.nextjs.on_request_error',
  });
});
