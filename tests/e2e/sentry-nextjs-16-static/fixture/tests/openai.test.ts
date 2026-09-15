import { expect, test } from '@playwright/test';
import { waitForStreamedSpans } from '@sentry-internal/test-utils';

// gen_ai spans are emitted as a separate span-v2 envelope item (not inline on the transaction), so we
// assert on the streamed spans. Attribute values are wrapped as `{ value, type }` in the v2 format.
test('Instruments openai automatically via orchestrion', async ({ baseURL }) => {
  const spansPromise = waitForStreamedSpans('nextjs-16-static', spans =>
    spans.some(span => span.attributes['sentry.origin']?.value === 'auto.ai.openai'),
  );

  await fetch(`${baseURL}/api/openai`);

  const spans = await spansPromise;

  const chatSpan = spans.find(span => span.name === 'chat gpt-3.5-turbo');
  expect(chatSpan).toBeDefined();
  expect(chatSpan?.attributes['sentry.op']?.value).toBe('gen_ai.chat');
  expect(chatSpan?.attributes['sentry.origin']?.value).toBe('auto.ai.openai');
  expect(chatSpan?.attributes['gen_ai.provider.name']?.value).toBe('openai');
  expect(chatSpan?.attributes['gen_ai.request.model']?.value).toBe('gpt-3.5-turbo');
  expect(chatSpan?.attributes['gen_ai.usage.input_tokens']?.value).toBe(10);
  expect(chatSpan?.attributes['gen_ai.usage.output_tokens']?.value).toBe(15);
  expect(chatSpan?.attributes['gen_ai.usage.total_tokens']?.value).toBe(25);
});
