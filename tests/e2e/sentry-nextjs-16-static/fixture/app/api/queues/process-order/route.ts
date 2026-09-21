import { handleCallback } from '../../../../lib/queue';

export const dynamic = 'force-dynamic';

// The @vercel/queue handleCallback return type (CallbackRequestInput) doesn't match
// Next.js's strict route handler type check with webpack builds, so we cast it.
export const POST = handleCallback(async (message, _metadata) => {
  // Simulate some async work
  await new Promise(resolve => setTimeout(resolve, 50));
}) as unknown as (req: Request) => Promise<Response>;
