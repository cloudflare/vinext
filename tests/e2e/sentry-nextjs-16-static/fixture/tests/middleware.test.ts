import { expect, test } from '@playwright/test';
import { waitForError, waitForTransaction } from '@sentry-internal/test-utils';
import { isDevMode } from './isDevMode';

test('Should create a transaction for middleware', async ({ request }) => {
  const middlewareTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'middleware GET';
  });

  const routeTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /api/endpoint-behind-middleware';
  });

  const response = await request.get('/api/endpoint-behind-middleware');
  expect(await response.json()).toStrictEqual({ name: 'John Doe' });

  const middlewareTransaction = await middlewareTransactionPromise;

  expect(middlewareTransaction.contexts?.trace?.status).toBe('ok');
  expect(middlewareTransaction.contexts?.trace?.op).toBe('middleware');
  expect(middlewareTransaction.contexts?.runtime?.name).toBe('node');
  expect(middlewareTransaction.transaction_info?.source).toBe('route');

  expect(middlewareTransaction.request?.method).toBe('GET');
  expect(middlewareTransaction.request?.url).toContain('/api/endpoint-behind-middleware');

  // The `Middleware.execute` OTEL root span is the only `middleware` span. The build-time
  // `wrapMiddlewareWithSentry` wrapper used to start a second, redundant one nested inside it.
  const nestedMiddlewareSpans = middlewareTransaction.spans?.filter(span => span.op === 'middleware');
  expect(nestedMiddlewareSpans).toHaveLength(0);

  // Assert that isolation scope works properly
  expect(middlewareTransaction.tags?.['my-isolated-tag']).toBe(true);
  expect(middlewareTransaction.tags?.['my-global-scope-isolated-tag']).not.toBeDefined();

  // Tags set in middleware must not leak into other requests' events (e.g. via a shared scope when the middleware
  // runs in a detached context - https://github.com/vercel/next.js/pull/95306)
  const routeTransaction = await routeTransactionPromise;
  expect(routeTransaction.tags?.['my-isolated-tag']).not.toBeDefined();
  expect(routeTransaction.tags?.['my-global-scope-isolated-tag']).not.toBeDefined();
});

test('Faulty middlewares', async ({ request }) => {
  test.skip(isDevMode, 'Throwing crashes the dev server atm'); // https://github.com/vercel/next.js/issues/85261
  const middlewareTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'middleware GET';
  });

  const errorEventPromise = waitForError('nextjs-16-static', errorEvent => {
    return errorEvent?.exception?.values?.[0]?.value === 'Middleware Error';
  });

  request.get('/api/endpoint-behind-middleware', { headers: { 'x-should-throw': '1' } }).catch(() => {
    // Noop
  });

  await test.step('should record transactions', async () => {
    const middlewareTransaction = await middlewareTransactionPromise;
    expect(middlewareTransaction.contexts?.trace?.status).toBe('internal_error');
    expect(middlewareTransaction.contexts?.trace?.op).toBe('middleware');
    expect(middlewareTransaction.contexts?.runtime?.name).toBe('node');
    expect(middlewareTransaction.transaction_info?.source).toBe('route');
  });

  // TODO: proxy errors currently not reported via onRequestError
  // await test.step('should record exceptions', async () => {
  //   const errorEvent = await errorEventPromise;

  //   // Assert that isolation scope works properly
  //   expect(errorEvent.tags?.['my-isolated-tag']).toBe(true);
  //   expect(errorEvent.tags?.['my-global-scope-isolated-tag']).not.toBeDefined();
  //   expect([
  //     'middleware GET', // non-otel webpack versions
  //     '/middleware', // middleware file
  //     '/proxy', // proxy file
  //   ]).toContain(errorEvent.transaction);
  // });
});

test('Should trace outgoing fetch requests inside middleware and create breadcrumbs for it', async ({ request }) => {
  test.skip(isDevMode, 'The fetch requests ends up in a separate tx in dev atm');
  const middlewareTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'middleware GET';
  });

  // In some builds (especially webpack), fetch spans may end up in a separate transaction instead of as child spans
  // This test validates that the fetch is traced either way
  const fetchTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return (
      transactionEvent?.transaction === 'GET http://localhost:3030/' ||
      transactionEvent?.contexts?.trace?.description === 'GET http://localhost:3030/'
    );
  });

  request.get('/api/endpoint-behind-middleware', { headers: { 'x-should-make-request': '1' } }).catch(() => {
    // Noop
  });

  const middlewareTransaction = await middlewareTransactionPromise;

  // Breadcrumbs should always be created for the fetch request
  expect(middlewareTransaction.breadcrumbs).toEqual(
    expect.arrayContaining([
      {
        category: 'http',
        data: { 'http.request.method': 'GET', status_code: 200, url: 'http://localhost:3030/' },
        timestamp: expect.any(Number),
        type: 'http',
      },
    ]),
  );

  // Check if http.client span exists as a child of the middleware transaction
  const hasHttpClientSpan = !!middlewareTransaction.spans?.find(span => span.op === 'http.client');

  if (hasHttpClientSpan) {
    // Check if fetch is traced as a child span of the middleware transaction
    expect(middlewareTransaction.spans).toContainEqual({
      data: {
        'http.request.method': 'GET',
        'http.request.method_original': 'GET',
        'http.response.status_code': 200,
        'network.peer.address': '::1',
        'network.peer.port': 3030,
        'sentry.kind': 'client',
        'sentry.op': 'http.client',
        'sentry.origin': 'auto.http.node_fetch',
        'server.address': 'localhost',
        'server.port': 3030,
        'url.domain': 'localhost',
        'url.full': 'http://localhost:3030/',
        'url.path': '/',
        'url.scheme': 'http',
        'user_agent.original': 'node',
      },
      description: 'GET http://localhost:3030/',
      op: 'http.client',
      origin: 'auto.http.node_fetch',
      parent_span_id: expect.stringMatching(/[a-f0-9]{16}/),
      span_id: expect.stringMatching(/[a-f0-9]{16}/),
      start_timestamp: expect.any(Number),
      status: 'ok',
      timestamp: expect.any(Number),
      trace_id: expect.stringMatching(/[a-f0-9]{32}/),
    });
  } else {
    // Alternatively, fetch is traced as a separate transaction, similar to Dev builds
    const fetchTransaction = await fetchTransactionPromise;

    expect(fetchTransaction.contexts?.trace?.op).toBe('http.client');
    expect(fetchTransaction.contexts?.trace?.status).toBe('ok');
    expect(fetchTransaction.contexts?.trace?.data?.['http.request.method']).toBe('GET');
    expect(fetchTransaction.contexts?.trace?.data?.['url.full']).toBe('http://localhost:3030/');
  }
});
