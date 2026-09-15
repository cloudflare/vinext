import { expect, test } from '@playwright/test';
import { waitForEnvelopeItem } from '@sentry-internal/test-utils';

test('Sends cron check-in envelope for successful cron job', async ({ request }) => {
  const inProgressEnvelopePromise = waitForEnvelopeItem('nextjs-16-static', envelope => {
    return (
      envelope[0].type === 'check_in' &&
      // @ts-expect-error envelope[1] is untyped
      envelope[1]['monitor_slug'] === '/api/cron-test' &&
      // @ts-expect-error envelope[1] is untyped
      envelope[1]['status'] === 'in_progress'
    );
  });

  const okEnvelopePromise = waitForEnvelopeItem('nextjs-16-static', envelope => {
    return (
      envelope[0].type === 'check_in' &&
      // @ts-expect-error envelope[1] is untyped
      envelope[1]['monitor_slug'] === '/api/cron-test' &&
      // @ts-expect-error envelope[1] is untyped
      envelope[1]['status'] === 'ok'
    );
  });

  const response = await request.get('/api/cron-test', {
    headers: {
      'User-Agent': 'vercel-cron/1.0',
    },
  });

  expect(response.status()).toBe(200);
  expect(await response.json()).toStrictEqual({ message: 'Cron job executed successfully' });

  const inProgressEnvelope = await inProgressEnvelopePromise;
  const okEnvelope = await okEnvelopePromise;

  expect(inProgressEnvelope[1]).toEqual(
    expect.objectContaining({
      check_in_id: expect.any(String),
      monitor_slug: '/api/cron-test',
      status: 'in_progress',
      monitor_config: {
        schedule: {
          type: 'crontab',
          value: '0 * * * *',
        },
        max_runtime: 720,
      },
    }),
  );

  expect(okEnvelope[1]).toEqual(
    expect.objectContaining({
      check_in_id: expect.any(String),
      monitor_slug: '/api/cron-test',
      status: 'ok',
      duration: expect.any(Number),
    }),
  );

  // @ts-expect-error envelope[1] is untyped
  expect(okEnvelope[1]['check_in_id']).toBe(inProgressEnvelope[1]['check_in_id']);
});

test('Sends cron check-in envelope with error status for failed cron job', async ({ request }) => {
  const inProgressEnvelopePromise = waitForEnvelopeItem('nextjs-16-static', envelope => {
    return (
      envelope[0].type === 'check_in' &&
      // @ts-expect-error envelope[1] is untyped
      envelope[1]['monitor_slug'] === '/api/cron-test-error' &&
      // @ts-expect-error envelope[1] is untyped
      envelope[1]['status'] === 'in_progress'
    );
  });

  const errorEnvelopePromise = waitForEnvelopeItem('nextjs-16-static', envelope => {
    return (
      envelope[0].type === 'check_in' &&
      // @ts-expect-error envelope[1] is untyped
      envelope[1]['monitor_slug'] === '/api/cron-test-error' &&
      // @ts-expect-error envelope[1] is untyped
      envelope[1]['status'] === 'error'
    );
  });

  await request.get('/api/cron-test-error', {
    headers: {
      'User-Agent': 'vercel-cron/1.0',
    },
  });

  const inProgressEnvelope = await inProgressEnvelopePromise;
  const errorEnvelope = await errorEnvelopePromise;

  expect(inProgressEnvelope[1]).toEqual(
    expect.objectContaining({
      check_in_id: expect.any(String),
      monitor_slug: '/api/cron-test-error',
      status: 'in_progress',
      monitor_config: {
        schedule: {
          type: 'crontab',
          value: '30 * * * *',
        },
        max_runtime: 720,
      },
    }),
  );

  expect(errorEnvelope[1]).toEqual(
    expect.objectContaining({
      check_in_id: expect.any(String),
      monitor_slug: '/api/cron-test-error',
      status: 'error',
      duration: expect.any(Number),
    }),
  );

  // @ts-expect-error envelope[1] is untyped
  expect(errorEnvelope[1]['check_in_id']).toBe(inProgressEnvelope[1]['check_in_id']);
});

test('Does not send cron check-in envelope for regular requests without vercel-cron user agent', async ({
  request,
}) => {
  let checkInReceived = false;

  waitForEnvelopeItem('nextjs-16-static', envelope => {
    if (
      envelope[0].type === 'check_in' && // @ts-expect-error envelope[1] is untyped
      envelope[1]['monitor_slug'] === '/api/cron-test'
    ) {
      checkInReceived = true;
      return true;
    }
    return false;
  });

  const response = await request.get('/api/cron-test');

  expect(response.status()).toBe(200);
  expect(await response.json()).toStrictEqual({ message: 'Cron job executed successfully' });

  await new Promise(resolve => setTimeout(resolve, 2000));

  expect(checkInReceived).toBe(false);
});
