import { generateText } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

export const dynamic = 'force-dynamic';

// Error trace handling in tool calls
async function runAITest() {
  const result = await generateText({
    experimental_telemetry: { isEnabled: true },
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
          throw new Error('Tool call failed');
        },
      },
    },
    prompt: 'What is the weather in San Francisco?',
  });
}

export default async function Page() {
  await Sentry.startSpan({ op: 'function', name: 'ai-error-test' }, async () => {
    return await runAITest();
  });

  return (
    <div>
      <h1>AI Test Results</h1>
    </div>
  );
}
