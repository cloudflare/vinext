'use server';

import { randomUUID } from 'crypto';
import { cookies } from 'next/headers';

export async function changeSessionAction() {
  const newSessionId = randomUUID().slice(0, 5);
  (await cookies()).set('session-id', newSessionId);
}
