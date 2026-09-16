import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getMockAiPort } from '../../../ai-mock-server.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  const port = await getMockAiPort();
  const client = new OpenAI({
    baseURL: `http://localhost:${port}/openai`,
    apiKey: 'mock-api-key',
  });

  await client.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  });

  return NextResponse.json({ status: 'ok' });
}
