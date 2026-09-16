import { QueueClient } from '@vercel/queue';

// For E2E testing, point the SDK at a local mock server running within Next.js.
// The mock API lives at app/api/v3/topic/[...params]/route.ts
const queue = new QueueClient({
  region: 'test1',
  resolveBaseUrl: () => new URL(`http://localhost:${process.env.PORT || 3030}`),
  token: 'mock-token',
  deploymentId: null,
});

export const { send, handleCallback } = queue;
