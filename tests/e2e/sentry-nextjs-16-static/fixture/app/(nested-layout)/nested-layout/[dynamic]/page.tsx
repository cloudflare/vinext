export const dynamic = 'force-dynamic';

export default async function Page() {
  return (
    <div>
      <p>Dynamic Page</p>
    </div>
  );
}

export async function generateMetadata() {
  return {
    title: 'I am dynamic page generated metadata',
  };
}
