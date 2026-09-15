import { expect, test } from '@playwright/test';
import { getSpanOp, waitForError, waitForStreamedSpans, waitForTransaction } from '@sentry-internal/test-utils';

// FIXME: This app uses `ai@^3`, which the channel-based Vercel AI integration doesn't instrument
// (it supports v4-v6 via the orchestrion transform and v7 via the native `ai:telemetry` channel).
// With channel-based instrumentation now the default, no gen_ai spans are produced. Re-enable once
// the app is upgraded to `ai@v7` (or v3 support is restored).
test.fixme('should create AI spans with correct attributes and error linking', async ({ page }) => {
  const aiTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent.transaction === 'GET /ai-error-test';
  });

  // gen_ai spans are extracted into a separate span v2 envelope item
  const genAiSpansPromise = waitForStreamedSpans('nextjs-16-static', spans =>
    spans.some(span => getSpanOp(span) === 'gen_ai.invoke_agent'),
  );

  const errorEventPromise = waitForError('nextjs-16-static', async errorEvent => {
    return !!errorEvent.exception?.values?.[0]?.value?.includes('Tool call failed');
  });

  await page.goto('/ai-error-test');

  const aiTransaction = await aiTransactionPromise;
  const genAiSpans = await genAiSpansPromise;
  const errorEvent = await errorEventPromise;

  expect(aiTransaction).toBeDefined();
  expect(aiTransaction.transaction).toBe('GET /ai-error-test');

  // Each generateText call should create 2 spans: one for the pipeline and one for doGenerate
  // Plus a span for the tool call
  // TODO: For now, this is sadly not fully working - the monkey patching of the ai package is not working
  // because of this, only spans that are manually opted-in at call time will be captured
  // this may be fixed by https://github.com/vercel/ai/pull/6716 in the future
  const aiPipelineSpans = genAiSpans.filter(span => getSpanOp(span) === 'gen_ai.invoke_agent');
  const aiGenerateSpans = genAiSpans.filter(span => getSpanOp(span) === 'gen_ai.generate_content');
  const toolCallSpans = genAiSpans.filter(span => getSpanOp(span) === 'gen_ai.execute_tool');

  expect(aiPipelineSpans.length).toBeGreaterThanOrEqual(1);
  expect(aiGenerateSpans.length).toBeGreaterThanOrEqual(1);
  expect(toolCallSpans.length).toBeGreaterThanOrEqual(0);

  expect(errorEvent).toBeDefined();

  //Verify error is linked to the same trace as the transaction
  expect(errorEvent?.contexts?.trace?.trace_id).toBe(aiTransaction.contexts?.trace?.trace_id);
});
