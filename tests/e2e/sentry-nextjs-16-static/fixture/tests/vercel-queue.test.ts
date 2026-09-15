import test, { expect } from '@playwright/test';
import { waitForTransaction } from '@sentry-internal/test-utils';

// The queue E2E test only runs in production mode.
// In development mode the @vercel/queue SDK uses an in-memory dispatch that
// bypasses our mock HTTP server, causing duplicate handler invocations.
const isProduction = process.env.TEST_ENV === 'production';

test('Should create transactions for queue producer and consumer', async ({ request }) => {
  test.skip(!isProduction, 'Vercel Queue test only runs in production mode');

  // 1. Set up waiters for both the producer and consumer transactions.
  const producerTransactionPromise = waitForTransaction('nextjs-16-static', transactionEvent => {
    return transactionEvent?.transaction === 'POST /api/queue-send';
  });

  const consumerTransactionPromise = waitForTransaction('nextjs-16-static', transactionEvent => {
    return transactionEvent?.transaction === 'POST /api/queues/process-order';
  });

  // 2. Hit the producer route to enqueue a message.
  const response = await request.post('/api/queue-send', {
    data: { topic: 'orders', payload: { orderId: 'e2e-test-123', action: 'fulfill' } },
    headers: { 'Content-Type': 'application/json' },
  });

  const responseBody = await response.json();
  expect(response.status()).toBe(200);
  expect(responseBody.messageId).toBeTruthy();

  // 3. Wait for the producer transaction.
  const producerTransaction = await producerTransactionPromise;
  expect(producerTransaction).toBeDefined();
  expect(producerTransaction.contexts?.trace?.op).toBe('http.server');
  expect(producerTransaction.contexts?.trace?.status).toBe('ok');

  // 4. Wait for the consumer transaction (the mock server pushes the message
  //    to the consumer route via CloudEvent POST).
  const consumerTransaction = await consumerTransactionPromise;
  expect(consumerTransaction).toBeDefined();
  expect(consumerTransaction.contexts?.trace?.op).toBe('http.server');
  expect(consumerTransaction.contexts?.trace?.status).toBe('ok');

  // 5. Verify the consumer span has messaging.* attributes from queue instrumentation.
  const consumerSpanData = consumerTransaction.contexts?.trace?.data;
  expect(consumerSpanData?.['messaging.system']).toBe('vercel.queue');
  expect(consumerSpanData?.['messaging.operation.name']).toBe('process');
  expect(consumerSpanData?.['messaging.destination.name']).toBe('orders');
  expect(consumerSpanData?.['messaging.message.id']).toBeTruthy();
  expect(consumerSpanData?.['messaging.consumer.group.name']).toBeTruthy();
});
