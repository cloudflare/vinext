export default async function AccountActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1 id="account-activity-page">Activity for {id}</h1>;
}
