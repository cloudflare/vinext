export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1 id="account-page">Account {id}</h1>;
}
