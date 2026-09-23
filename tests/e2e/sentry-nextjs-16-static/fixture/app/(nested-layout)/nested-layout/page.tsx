export const dynamic = 'force-dynamic';

export default function Page() {
  return <p>Hello World!</p>;
}

export async function generateMetadata() {
  return {
    title: 'I am generated metadata',
  };
}
