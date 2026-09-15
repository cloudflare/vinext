import { expect, test } from '@playwright/test';
import { getSpanOp, waitForStreamedSpans, waitForTransaction } from '@sentry-internal/test-utils';

// FIXME: This app uses `ai@^3`, which the channel-based Vercel AI integration doesn't instrument
// (it supports v4-v6 via the orchestrion transform and v7 via the native `ai:telemetry` channel).
// With channel-based instrumentation now the default, no gen_ai spans are produced. Re-enable once
// the app is upgraded to `ai@v7` (or v3 support is restored).
test.fixme('should create AI spans with correct attributes', async ({ page }) => {
  const aiTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent.transaction === 'GET /ai-test';
  });

  // gen_ai spans are extracted into a separate span v2 envelope item
  const genAiSpansPromise = waitForStreamedSpans('nextjs-16-static', spans =>
    spans.some(span => getSpanOp(span) === 'gen_ai.invoke_agent'),
  );

  await page.goto('/ai-test');

  const aiTransaction = await aiTransactionPromise;
  const genAiSpans = await genAiSpansPromise;

  expect(aiTransaction).toBeDefined();
  expect(aiTransaction.transaction).toBe('GET /ai-test');

  // We expect spans for the first 3 AI calls (4th is disabled)
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

  // First AI call - should have telemetry enabled and record inputs/outputs by default
  /* const firstPipelineSpan = aiPipelineSpans[0];
  expect(firstPipelineSpan?.attributes['vercel.ai.model.id']?.value).toBe('mock-model-id');
  expect(firstPipelineSpan?.attributes['vercel.ai.model.provider']?.value).toBe('mock-provider');
  expect(firstPipelineSpan?.attributes['vercel.ai.prompt']?.value).toContain('Where is the first span?');
  expect(firstPipelineSpan?.attributes['gen_ai.output.messages']?.value).toContain('First span here!');
  expect(firstPipelineSpan?.attributes['gen_ai.usage.input_tokens']?.value).toBe(10);
  expect(firstPipelineSpan?.attributes['gen_ai.usage.output_tokens']?.value).toBe(20); */

  // Second AI call - explicitly enabled telemetry
  const secondPipelineSpan = aiPipelineSpans[0];
  expect(secondPipelineSpan?.attributes['vercel.ai.prompt']?.value).toContain('Where is the second span?');
  expect(secondPipelineSpan?.attributes['gen_ai.output.messages']?.value).toContain('Second span here!');

  // Third AI call - with tool calls
  /*  const thirdPipelineSpan = aiPipelineSpans[2];
  expect(thirdPipelineSpan?.attributes['vercel.ai.response.finishReason']?.value).toBe('tool-calls');
  expect(thirdPipelineSpan?.attributes['gen_ai.usage.input_tokens']?.value).toBe(15);
  expect(thirdPipelineSpan?.attributes['gen_ai.usage.output_tokens']?.value).toBe(25); */

  // Tool call span
  /*  const toolSpan = toolCallSpans[0];
  expect(toolSpan?.attributes['vercel.ai.toolCall.name']?.value).toBe('getWeather');
  expect(toolSpan?.attributes['vercel.ai.toolCall.id']?.value).toBe('call-1');
  expect(toolSpan?.attributes['vercel.ai.toolCall.args']?.value).toContain('San Francisco');
  expect(toolSpan?.attributes['vercel.ai.toolCall.result']?.value).toContain('Sunny, 72°F'); */

  // Verify the fourth call was not captured (telemetry disabled)
  const promptsInSpans = genAiSpans
    .map(span => span.attributes['vercel.ai.prompt']?.value)
    .filter((prompt): prompt is string => typeof prompt === 'string');
  const hasDisabledPrompt = promptsInSpans.some(prompt => prompt.includes('Where is the third span?'));
  expect(hasDisabledPrompt).toBe(false);

  // Verify results are displayed on the page
  const resultsText = await page.locator('#ai-results').textContent();
  expect(resultsText).toContain('First span here!');
  expect(resultsText).toContain('Second span here!');
  expect(resultsText).toContain('Tool call completed!');
  expect(resultsText).toContain('Third span here!');
});
