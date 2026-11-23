'use server';

import { refresh } from 'next/cache';

export async function refreshAction() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  refresh();
}
