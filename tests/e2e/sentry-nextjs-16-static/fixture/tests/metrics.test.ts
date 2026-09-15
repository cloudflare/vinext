import { expect, test } from '@playwright/test';
import { waitForMetric } from '@sentry-internal/test-utils';

test('Should emit metrics from server and client', async ({ request, page }) => {
  const clientCountPromise = waitForMetric('nextjs-16-static', async metric => {
    return metric.name === 'test.page.count';
  });

  const clientDistributionPromise = waitForMetric('nextjs-16-static', async metric => {
    return metric.name === 'test.page.distribution';
  });

  const clientGaugePromise = waitForMetric('nextjs-16-static', async metric => {
    return metric.name === 'test.page.gauge';
  });

  const serverCountPromise = waitForMetric('nextjs-16-static', async metric => {
    return metric.name === 'test.route.handler.count';
  });

  const serverDistributionPromise = waitForMetric('nextjs-16-static', async metric => {
    return metric.name === 'test.route.handler.distribution';
  });

  const serverGaugePromise = waitForMetric('nextjs-16-static', async metric => {
    return metric.name === 'test.route.handler.gauge';
  });

  await page.goto('/metrics');
  await page.getByText('Emit').click();
  const clientCount = await clientCountPromise;
  const clientDistribution = await clientDistributionPromise;
  const clientGauge = await clientGaugePromise;
  const serverCount = await serverCountPromise;
  const serverDistribution = await serverDistributionPromise;
  const serverGauge = await serverGaugePromise;

  expect(clientCount).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    span_id: expect.any(String),
    name: 'test.page.count',
    type: 'counter',
    value: 1,
    attributes: {
      page: { value: '/metrics', type: 'string' },
      'random.attribute': { value: 'Apples', type: 'string' },
      'sentry.environment': { value: 'qa', type: 'string' },
      'sentry.sdk.name': { value: 'sentry.javascript.nextjs', type: 'string' },
      'sentry.sdk.version': { value: expect.any(String), type: 'string' },
    },
  });

  expect(clientDistribution).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    span_id: expect.any(String),
    name: 'test.page.distribution',
    type: 'distribution',
    value: 100,
    attributes: {
      page: { value: '/metrics', type: 'string' },
      'random.attribute': { value: 'Manzanas', type: 'string' },
      'sentry.environment': { value: 'qa', type: 'string' },
      'sentry.sdk.name': { value: 'sentry.javascript.nextjs', type: 'string' },
      'sentry.sdk.version': { value: expect.any(String), type: 'string' },
    },
  });

  expect(clientGauge).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    span_id: expect.any(String),
    name: 'test.page.gauge',
    type: 'gauge',
    value: 200,
    attributes: {
      page: { value: '/metrics', type: 'string' },
      'random.attribute': { value: 'Mele', type: 'string' },
      'sentry.environment': { value: 'qa', type: 'string' },
      'sentry.sdk.name': { value: 'sentry.javascript.nextjs', type: 'string' },
      'sentry.sdk.version': { value: expect.any(String), type: 'string' },
    },
  });

  expect(serverCount).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'test.route.handler.count',
    type: 'counter',
    value: 1,
    attributes: {
      'server.address': { value: expect.any(String), type: 'string' },
      'random.attribute': { value: 'Potatoes', type: 'string' },
      endpoint: { value: '/metrics/route-handler', type: 'string' },
      'sentry.environment': { value: 'qa', type: 'string' },
      'sentry.sdk.name': { value: 'sentry.javascript.nextjs', type: 'string' },
      'sentry.sdk.version': { value: expect.any(String), type: 'string' },
    },
  });

  expect(serverDistribution).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'test.route.handler.distribution',
    type: 'distribution',
    value: 100,
    attributes: {
      'server.address': { value: expect.any(String), type: 'string' },
      'random.attribute': { value: 'Patatas', type: 'string' },
      endpoint: { value: '/metrics/route-handler', type: 'string' },
      'sentry.environment': { value: 'qa', type: 'string' },
      'sentry.sdk.name': { value: 'sentry.javascript.nextjs', type: 'string' },
      'sentry.sdk.version': { value: expect.any(String), type: 'string' },
    },
  });

  expect(serverGauge).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'test.route.handler.gauge',
    type: 'gauge',
    value: 200,
    attributes: {
      'server.address': { value: expect.any(String), type: 'string' },
      'random.attribute': { value: 'Patate', type: 'string' },
      endpoint: { value: '/metrics/route-handler', type: 'string' },
      'sentry.environment': { value: 'qa', type: 'string' },
      'sentry.sdk.name': { value: 'sentry.javascript.nextjs', type: 'string' },
      'sentry.sdk.version': { value: expect.any(String), type: 'string' },
    },
  });
});
