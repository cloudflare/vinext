import { expect, test } from '@playwright/test';
import { waitForTransaction } from '@sentry-internal/test-utils';

test('should create a parameterized transaction when the `app` directory is used', async ({ page }) => {
  const transactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return (
      transactionEvent.transaction === '/parameterized/:one' && transactionEvent.contexts?.trace?.op === 'pageload'
    );
  });

  await page.goto(`/parameterized/cappuccino`);

  const transaction = await transactionPromise;

  expect(transaction).toMatchObject({
    contexts: {
      react: { version: expect.any(String) },
      trace: {
        data: {
          'sentry.op': 'pageload',
          'sentry.origin': 'auto.pageload.nextjs.app_router_instrumentation',
          'sentry.segment.name.source': 'route',
          'url.full': expect.stringMatching(/^https?:\/\/localhost:\d+\/parameterized\/cappuccino$/),
          'url.path': '/parameterized/cappuccino',
          'url.template': '/parameterized/:one',
        },
        op: 'pageload',
        origin: 'auto.pageload.nextjs.app_router_instrumentation',
        span_id: expect.stringMatching(/[a-f0-9]{16}/),
        trace_id: expect.stringMatching(/[a-f0-9]{32}/),
      },
    },
    environment: 'qa',
    request: {
      headers: expect.any(Object),
      url: expect.stringMatching(/\/parameterized\/cappuccino$/),
    },
    start_timestamp: expect.any(Number),
    timestamp: expect.any(Number),
    transaction: '/parameterized/:one',
    transaction_info: { source: 'route' },
    type: 'transaction',
  });
});

test('should create a transaction named after the static route when the `app` directory is used', async ({ page }) => {
  const transactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return (
      transactionEvent.transaction === '/parameterized/static' && transactionEvent.contexts?.trace?.op === 'pageload'
    );
  });

  await page.goto(`/parameterized/static`);

  const transaction = await transactionPromise;

  expect(transaction).toMatchObject({
    contexts: {
      react: { version: expect.any(String) },
      trace: {
        data: {
          'sentry.op': 'pageload',
          'sentry.origin': 'auto.pageload.nextjs.app_router_instrumentation',
          'sentry.segment.name.source': 'route',
          'url.full': expect.stringMatching(/^https?:\/\/localhost:\d+\/parameterized\/static$/),
          'url.path': '/parameterized/static',
          'url.template': '/parameterized/static',
        },
        op: 'pageload',
        origin: 'auto.pageload.nextjs.app_router_instrumentation',
        span_id: expect.stringMatching(/[a-f0-9]{16}/),
        trace_id: expect.stringMatching(/[a-f0-9]{32}/),
      },
    },
    environment: 'qa',
    request: {
      headers: expect.any(Object),
      url: expect.stringMatching(/\/parameterized\/static$/),
    },
    start_timestamp: expect.any(Number),
    timestamp: expect.any(Number),
    transaction: '/parameterized/static',
    transaction_info: { source: 'route' },
    type: 'transaction',
  });
});

test('should create a partially parameterized transaction when the `app` directory is used', async ({ page }) => {
  const transactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return (
      transactionEvent.transaction === '/parameterized/:one/beep' && transactionEvent.contexts?.trace?.op === 'pageload'
    );
  });

  await page.goto(`/parameterized/cappuccino/beep`);

  const transaction = await transactionPromise;

  expect(transaction).toMatchObject({
    contexts: {
      react: { version: expect.any(String) },
      trace: {
        data: {
          'sentry.op': 'pageload',
          'sentry.origin': 'auto.pageload.nextjs.app_router_instrumentation',
          'sentry.segment.name.source': 'route',
          'url.full': expect.stringMatching(/^https?:\/\/localhost:\d+\/parameterized\/cappuccino\/beep$/),
          'url.path': '/parameterized/cappuccino/beep',
          'url.template': '/parameterized/:one/beep',
        },
        op: 'pageload',
        origin: 'auto.pageload.nextjs.app_router_instrumentation',
        span_id: expect.stringMatching(/[a-f0-9]{16}/),
        trace_id: expect.stringMatching(/[a-f0-9]{32}/),
      },
    },
    environment: 'qa',
    request: {
      headers: expect.any(Object),
      url: expect.stringMatching(/\/parameterized\/cappuccino\/beep$/),
    },
    start_timestamp: expect.any(Number),
    timestamp: expect.any(Number),
    transaction: '/parameterized/:one/beep',
    transaction_info: { source: 'route' },
    type: 'transaction',
  });
});

test('should create a nested parameterized transaction when the `app` directory is used.', async ({ page }) => {
  const transactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return (
      transactionEvent.transaction === '/parameterized/:one/beep/:two' &&
      transactionEvent.contexts?.trace?.op === 'pageload'
    );
  });

  await page.goto(`/parameterized/cappuccino/beep/espresso`);

  const transaction = await transactionPromise;

  expect(transaction).toMatchObject({
    contexts: {
      react: { version: expect.any(String) },
      trace: {
        data: {
          'sentry.op': 'pageload',
          'sentry.origin': 'auto.pageload.nextjs.app_router_instrumentation',
          'sentry.segment.name.source': 'route',
          'url.full': expect.stringMatching(/^https?:\/\/localhost:\d+\/parameterized\/cappuccino\/beep\/espresso$/),
          'url.path': '/parameterized/cappuccino/beep/espresso',
          'url.template': '/parameterized/:one/beep/:two',
        },
        op: 'pageload',
        origin: 'auto.pageload.nextjs.app_router_instrumentation',
        span_id: expect.stringMatching(/[a-f0-9]{16}/),
        trace_id: expect.stringMatching(/[a-f0-9]{32}/),
      },
    },
    environment: 'qa',
    request: {
      headers: expect.any(Object),
      url: expect.stringMatching(/\/parameterized\/cappuccino\/beep\/espresso$/),
    },
    start_timestamp: expect.any(Number),
    timestamp: expect.any(Number),
    transaction: '/parameterized/:one/beep/:two',
    transaction_info: { source: 'route' },
    type: 'transaction',
  });
});
