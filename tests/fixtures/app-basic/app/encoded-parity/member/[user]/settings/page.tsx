export const revalidate = 60;

export default async function EncodedMemberSettingsPage({
  params,
}: {
  params: Promise<{ user: string }>;
}) {
  const { user } = await params;
  return <p data-testid="encoded-member">{`settings for ${user}`}</p>;
}
