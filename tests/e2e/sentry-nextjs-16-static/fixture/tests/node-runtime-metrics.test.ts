import { expect, test } from '@playwright/test';
import { waitForMetric } from '@sentry-internal/test-utils';

const EXPECTED_ATTRIBUTES = {
  'sentry.environment': { value: 'qa', type: 'string' },
  'sentry.sdk.name': { value: 'sentry.javascript.nextjs', type: 'string' },
  'sentry.sdk.version': { value: expect.any(String), type: 'string' },
  'sentry.origin': { value: 'auto.node.runtime_metrics', type: 'string' },
};

test('Should emit node runtime memory metrics', async ({ baseURL }) => {
  const rssPromise = waitForMetric('nextjs-16-static', metric => {
    return metric.name === 'node.runtime.mem.rss';
  });

  const heapUsedPromise = waitForMetric('nextjs-16-static', metric => {
    return metric.name === 'node.runtime.mem.heap_used';
  });

  const heapTotalPromise = waitForMetric('nextjs-16-static', metric => {
    return metric.name === 'node.runtime.mem.heap_total';
  });

  // Trigger a request to ensure the server is running and metrics start being collected
  await fetch(`${baseURL}/`);

  const rss = await rssPromise;
  const heapUsed = await heapUsedPromise;
  const heapTotal = await heapTotalPromise;

  expect(rss).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'node.runtime.mem.rss',
    type: 'gauge',
    unit: 'byte',
    value: expect.any(Number),
    attributes: expect.objectContaining(EXPECTED_ATTRIBUTES),
  });

  expect(heapUsed).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'node.runtime.mem.heap_used',
    type: 'gauge',
    unit: 'byte',
    value: expect.any(Number),
    attributes: expect.objectContaining(EXPECTED_ATTRIBUTES),
  });

  expect(heapTotal).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'node.runtime.mem.heap_total',
    type: 'gauge',
    unit: 'byte',
    value: expect.any(Number),
    attributes: expect.objectContaining(EXPECTED_ATTRIBUTES),
  });
});

test('Should emit node runtime CPU utilization metric', async ({ baseURL }) => {
  const cpuUtilPromise = waitForMetric('nextjs-16-static', metric => {
    return metric.name === 'node.runtime.cpu.utilization';
  });

  await fetch(`${baseURL}/`);

  const cpuUtil = await cpuUtilPromise;

  expect(cpuUtil).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'node.runtime.cpu.utilization',
    type: 'gauge',
    value: expect.any(Number),
    attributes: expect.objectContaining(EXPECTED_ATTRIBUTES),
  });
});

test('Should emit node runtime event loop metrics', async ({ baseURL }) => {
  const elDelayP50Promise = waitForMetric('nextjs-16-static', metric => {
    return metric.name === 'node.runtime.event_loop.delay.p50';
  });

  const elDelayP99Promise = waitForMetric('nextjs-16-static', metric => {
    return metric.name === 'node.runtime.event_loop.delay.p99';
  });

  const elUtilPromise = waitForMetric('nextjs-16-static', metric => {
    return metric.name === 'node.runtime.event_loop.utilization';
  });

  await fetch(`${baseURL}/`);

  const elDelayP50 = await elDelayP50Promise;
  const elDelayP99 = await elDelayP99Promise;
  const elUtil = await elUtilPromise;

  expect(elDelayP50).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'node.runtime.event_loop.delay.p50',
    type: 'gauge',
    unit: 'second',
    value: expect.any(Number),
    attributes: expect.objectContaining(EXPECTED_ATTRIBUTES),
  });

  expect(elDelayP99).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'node.runtime.event_loop.delay.p99',
    type: 'gauge',
    unit: 'second',
    value: expect.any(Number),
    attributes: expect.objectContaining(EXPECTED_ATTRIBUTES),
  });

  expect(elUtil).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'node.runtime.event_loop.utilization',
    type: 'gauge',
    value: expect.any(Number),
    attributes: expect.objectContaining(EXPECTED_ATTRIBUTES),
  });
});

test('Should emit node runtime uptime counter', async ({ baseURL }) => {
  const uptimePromise = waitForMetric('nextjs-16-static', metric => {
    return metric.name === 'node.runtime.process.uptime';
  });

  await fetch(`${baseURL}/`);

  const uptime = await uptimePromise;

  expect(uptime).toMatchObject({
    timestamp: expect.any(Number),
    trace_id: expect.any(String),
    name: 'node.runtime.process.uptime',
    type: 'counter',
    unit: 'second',
    value: expect.any(Number),
    attributes: expect.objectContaining(EXPECTED_ATTRIBUTES),
  });
});
