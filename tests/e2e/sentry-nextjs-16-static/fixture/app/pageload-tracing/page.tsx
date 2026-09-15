export const dynamic = 'force-dynamic';

export default async function Page() {
  await new Promise(resolve => setTimeout(resolve, 1000));
  return <p>I am page 2</p>;
}

export async function generateMetadata() {
  (await fetch('https://example.com/', { cache: 'no-store' })).text();

  return {
    title: 'my title',
  };
}
