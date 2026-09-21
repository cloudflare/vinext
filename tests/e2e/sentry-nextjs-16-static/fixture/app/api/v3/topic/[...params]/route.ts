import { NextResponse } from 'next/server';

/**
 * Mock Vercel Queues API server.
 *
 * This route handler simulates the Vercel Queues HTTP API so that the real
 * @vercel/queue SDK can be used in E2E tests without Vercel infrastructure.
 *
 * Handled endpoints:
 *   POST   /api/v3/topic/{topic}                                         → SendMessage
 *   POST   /api/v3/topic/{topic}/consumer/{consumer}/id/{messageId}      → ReceiveMessageById
 *   DELETE /api/v3/topic/{topic}/consumer/{consumer}/lease/{handle}       → AcknowledgeMessage
 *   PATCH  /api/v3/topic/{topic}/consumer/{consumer}/lease/{handle}       → ExtendLease
 */

export const dynamic = 'force-dynamic';

let messageCounter = 0;

function generateMessageId(): string {
  return `msg_test_${++messageCounter}_${Date.now()}`;
}

function generateReceiptHandle(): string {
  return `rh_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Encode a file path into a consumer-group name, matching the SDK's algorithm.
function filePathToConsumerGroup(filePath: string): string {
  let result = '';
  for (const char of filePath) {
    if (char === '_') result += '__';
    else if (char === '/') result += '_S';
    else if (char === '.') result += '_D';
    else if (/[A-Za-z0-9-]/.test(char)) result += char;
    else result += '_' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return result;
}

// Topic → consumer route path (mirrors vercel.json experimentalTriggers).
const TOPIC_ROUTES: Record<string, string> = {
  orders: '/api/queues/process-order',
};

// The file path key used in vercel.json for each consumer route.
const ROUTE_FILE_PATHS: Record<string, string> = {
  '/api/queues/process-order': 'app/api/queues/process-order/route.ts',
};

export async function POST(request: Request, { params }: { params: Promise<{ params: string[] }> }) {
  const { params: segments } = await params;

  // POST /api/v3/topic/{topic} → SendMessage
  if (segments.length === 1) {
    const topic = segments[0];
    const body = await request.arrayBuffer();
    const messageId = generateMessageId();
    const receiptHandle = generateReceiptHandle();
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
    const visibilityDeadline = new Date(now.getTime() + 300_000).toISOString();

    const consumerRoute = TOPIC_ROUTES[topic];
    if (consumerRoute) {
      const filePath = ROUTE_FILE_PATHS[consumerRoute] ?? consumerRoute;
      const consumerGroup = filePathToConsumerGroup(filePath);
      const port = process.env.PORT || 3030;

      // Simulate Vercel infrastructure pushing the message to the consumer.
      // Fire-and-forget so the SendMessage response returns immediately.
      void fetch(`http://localhost:${port}${consumerRoute}`, {
        method: 'POST',
        headers: {
          'ce-type': 'com.vercel.queue.v2beta',
          'ce-vqsqueuename': topic,
          'ce-vqsconsumergroup': consumerGroup,
          'ce-vqsmessageid': messageId,
          'ce-vqsreceipthandle': receiptHandle,
          'ce-vqsdeliverycount': '1',
          'ce-vqscreatedat': createdAt,
          'ce-vqsexpiresat': expiresAt,
          'ce-vqsregion': 'test1',
          'ce-vqsvisibilitydeadline': visibilityDeadline,
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        body: Buffer.from(body),
      }).catch(err => console.error('[mock-queue] Failed to push to consumer:', err));
    }

    return NextResponse.json({ messageId }, { status: 201, headers: { 'Vqs-Message-Id': messageId } });
  }

  // POST /api/v3/topic/{topic}/consumer/{consumer}/id/{messageId} → ReceiveMessageById
  // Not used in binary-mode push flow, but handled for completeness.
  if (segments.length >= 4 && segments[1] === 'consumer') {
    return new Response(null, { status: 204 });
  }

  return NextResponse.json({ error: 'Unknown endpoint' }, { status: 404 });
}

// DELETE /api/v3/topic/{topic}/consumer/{consumer}/lease/{receiptHandle} → AcknowledgeMessage
export async function DELETE() {
  return new Response(null, { status: 204 });
}

// PATCH /api/v3/topic/{topic}/consumer/{consumer}/lease/{receiptHandle} → ExtendLease
export async function PATCH() {
  return NextResponse.json({ success: true });
}
