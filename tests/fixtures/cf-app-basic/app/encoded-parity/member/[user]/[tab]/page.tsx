export const revalidate = 60;

export default async function EncodedMemberTabPage({
  params,
}: {
  params: Promise<{ user: string; tab: string }>;
}) {
  const { user, tab } = await params;
  return <p data-testid="encoded-member">{`tab ${tab} for ${user}`}</p>;
}
