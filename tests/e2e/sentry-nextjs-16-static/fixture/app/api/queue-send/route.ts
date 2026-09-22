import { NextResponse } from 'next/server';
import { send } from '../../../lib/queue';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json();
  const topic = body.topic ?? 'orders';
  const payload = body.payload ?? body;

  const { messageId } = await send(topic, payload);

  return NextResponse.json({ messageId });
}
