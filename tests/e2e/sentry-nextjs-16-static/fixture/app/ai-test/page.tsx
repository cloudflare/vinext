import { generateText } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

export const dynamic = 'force-dynamic';

async function runAITest() {
  // First span - telemetry should be enabled automatically but no input/output recorded by default
  const result1 = await generateText({
    model: new MockLanguageModelV1({
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20 },
        text: 'First span here!',
      }),
    }),
    prompt: 'Where is the first span?',
  });

  // Second span - explicitly enabled telemetry, should record inputs/outputs
  const result2 = await generateText({
    experimental_telemetry: { isEnabled: true },
    model: new MockLanguageModelV1({
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20 },
        text: 'Second span here!',
      }),
    }),
    prompt: 'Where is the second span?',
  });

  // Third span - with tool calls and tool results
  const result3 = await generateText({
    model: new MockLanguageModelV1({
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: 'tool-calls',
        usage: { promptTokens: 15, completionTokens: 25 },
        text: 'Tool call completed!',
        toolCalls: [
          {
            toolCallType: 'function',
            toolCallId: 'call-1',
            toolName: 'getWeather',
            args: '{ "location": "San Francisco" }',
          },
        ],
      }),
    }),
    tools: {
      getWeather: {
        parameters: z.object({ location: z.string() }),
        execute: async args => {
          return `Weather in ${args.location}: Sunny, 72°F`;
        },
      },
    },
    prompt: 'What is the weather in San Francisco?',
  });

  // Fourth span - explicitly disabled telemetry, should not be captured
  const result4 = await generateText({
    experimental_telemetry: { isEnabled: false },
    model: new MockLanguageModelV1({
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20 },
        text: 'Third span here!',
      }),
    }),
    prompt: 'Where is the third span?',
  });

  return {
    result1: result1.text,
    result2: result2.text,
    result3: result3.text,
    result4: result4.text,
  };
}

export default async function Page() {
  const results = await Sentry.startSpan({ op: 'function', name: 'ai-test' }, async () => {
    return await runAITest();
  });

  return (
    <div>
      <h1>AI Test Results</h1>
      <pre id="ai-results">{JSON.stringify(results, null, 2)}</pre>
    </div>
  );
}
