import Redis from 'ioredis';
import { Client } from 'pg';

export const dynamic = 'force-dynamic';

async function queryDatabases(): Promise<{ answer: string; cached: string | null }> {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'docker',
    database: 'postgres',
  });

  await client.connect();

  let answer: string;
  try {
    const result = await client.query('SELECT 40 + 2 AS answer');
    answer = String(result.rows[0]?.answer);
  } finally {
    await client.end();
  }

  const redis = new Redis({
    // Don't keep retrying forever if Redis goes away (e.g. on test teardown)
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  let cached: string | null;
  try {
    await redis.set('page-key', answer);
    cached = await redis.get('page-key');
  } finally {
    redis.disconnect();
  }

  return { answer, cached };
}

export default async function DbPage() {
  const { answer, cached } = await queryDatabases();

  return (
    <div>
      <h1>DB page</h1>
      <p id="answer">answer: {answer}</p>
      <p id="cached">cached: {cached}</p>
    </div>
  );
}
