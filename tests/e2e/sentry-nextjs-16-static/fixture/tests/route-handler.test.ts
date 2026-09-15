import test, { expect } from '@playwright/test';
import { waitForError, waitForTransaction } from '@sentry-internal/test-utils';
import { isTurbopackDevMode } from './isDevMode';

test('Should create a transaction for node route handlers', async ({ request }) => {
  test.skip(isTurbopackDevMode, 'Turbopack intermittently returns 404 for dynamic routes in dev mode');

  const routehandlerTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /route-handler/[xoxo]/node';
  });

  const response = await request.get('/route-handler/123/node', { headers: { 'x-charly': 'gomez' } });
  expect(await response.json()).toStrictEqual({ message: 'Hello Node Route Handler' });

  const routehandlerTransaction = await routehandlerTransactionPromise;

  expect(routehandlerTransaction.contexts?.trace?.status).toBe('ok');
  expect(routehandlerTransaction.contexts?.trace?.op).toBe('http.server');
  expect(routehandlerTransaction.contexts?.trace?.data?.['http.request.header.x-charly']).toBe('gomez');
});

test('Should create a transaction for edge route handlers', async ({ request }) => {
  // This test only works for webpack builds on non-async param extraction
  // todo: check if we can set request headers for edge on sdkProcessingMetadata
  test.skip();
  const routehandlerTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /route-handler/[xoxo]/edge';
  });

  const response = await request.get('/route-handler/123/edge', { headers: { 'x-charly': 'gomez' } });
  expect(await response.json()).toStrictEqual({ message: 'Hello Edge Route Handler' });

  const routehandlerTransaction = await routehandlerTransactionPromise;

  expect(routehandlerTransaction.contexts?.trace?.status).toBe('ok');
  expect(routehandlerTransaction.contexts?.trace?.op).toBe('http.server');
  expect(routehandlerTransaction.contexts?.trace?.data?.['http.request.header.x-charly']).toBe('gomez');
});

test('Should report an error with a parameterized transaction name for a throwing route handler', async ({
  request,
}) => {
  test.skip(isTurbopackDevMode, 'Turbopack intermittently returns 404 for dynamic routes in dev mode');

  const errorEventPromise = waitForError('nextjs-16-static', errorEvent => {
    return errorEvent?.exception?.values?.some(value => value.value === 'route-handler-error') ?? false;
  });

  const transactionEventPromise = waitForTransaction('nextjs-16-static', transactionEvent => {
    return (
      transactionEvent?.transaction === 'GET /route-handler/[xoxo]/error' &&
      transactionEvent?.contexts?.trace?.op === 'http.server'
    );
  });

  request.get('/route-handler/456/error').catch(() => {});

  const errorEvent = await errorEventPromise;
  const transactionEvent = await transactionEventPromise;

  // Error event should be part of the same trace as the transaction
  expect(errorEvent.contexts?.trace?.trace_id).toBe(transactionEvent.contexts?.trace?.trace_id);

  // Error should carry the parameterized transaction name
  expect(errorEvent.transaction).toBe('GET /route-handler/[xoxo]/error');

  // Transaction should have parameterized name and internal_error status
  expect(transactionEvent.transaction).toBe('GET /route-handler/[xoxo]/error');
  expect(transactionEvent.contexts?.trace?.status).toBe('internal_error');
});

test('Should set a parameterized transaction name on a captureMessage event in a route handler', async ({
  request,
}) => {
  test.skip(isTurbopackDevMode, 'Turbopack intermittently returns 404 for dynamic routes in dev mode');

  const messageEventPromise = waitForError('nextjs-16-static', event => {
    return event?.message === 'route-handler-message';
  });

  const transactionEventPromise = waitForTransaction('nextjs-16-static', transactionEvent => {
    return (
      transactionEvent?.transaction === 'GET /route-handler/[xoxo]/capture-message' &&
      transactionEvent?.contexts?.trace?.op === 'http.server'
    );
  });

  const response = await request.get('/route-handler/789/capture-message');
  expect(await response.json()).toStrictEqual({ message: 'Message captured' });

  const messageEvent = await messageEventPromise;
  const transactionEvent = await transactionEventPromise;

  // Message event should be part of the same trace as the transaction
  expect(messageEvent.contexts?.trace?.trace_id).toBe(transactionEvent.contexts?.trace?.trace_id);

  // Message should carry the parameterized transaction name
  expect(messageEvent.transaction).toBe('GET /route-handler/[xoxo]/capture-message');

  // Transaction should have parameterized name and ok status
  expect(transactionEvent.transaction).toBe('GET /route-handler/[xoxo]/capture-message');
  expect(transactionEvent.contexts?.trace?.status).toBe('ok');
});

test('Should set a parameterized transaction name on a captureException event in a route handler', async ({
  request,
}) => {
  test.skip(isTurbopackDevMode, 'Turbopack intermittently returns 404 for dynamic routes in dev mode');

  const errorEventPromise = waitForError('nextjs-16-static', errorEvent => {
    return errorEvent?.exception?.values?.some(value => value.value === 'route-handler-capture-exception') ?? false;
  });

  const transactionEventPromise = waitForTransaction('nextjs-16-static', transactionEvent => {
    return (
      transactionEvent?.transaction === 'GET /route-handler/[xoxo]/capture-exception' &&
      transactionEvent?.contexts?.trace?.op === 'http.server'
    );
  });

  const response = await request.get('/route-handler/321/capture-exception');
  expect(await response.json()).toStrictEqual({ message: 'Exception captured' });

  const errorEvent = await errorEventPromise;
  const transactionEvent = await transactionEventPromise;

  // Error event should be part of the same trace as the transaction
  expect(errorEvent.contexts?.trace?.trace_id).toBe(transactionEvent.contexts?.trace?.trace_id);

  // Manually captured exception should carry the parameterized transaction name
  expect(errorEvent.transaction).toBe('GET /route-handler/[xoxo]/capture-exception');

  // Transaction should have parameterized name and ok status (error was caught, not thrown)
  expect(transactionEvent.transaction).toBe('GET /route-handler/[xoxo]/capture-exception');
  expect(transactionEvent.contexts?.trace?.status).toBe('ok');
});
