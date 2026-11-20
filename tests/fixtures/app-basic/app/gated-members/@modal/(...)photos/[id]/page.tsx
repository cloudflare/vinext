// Intercepts /photos/[id] from a member page, which only clients with the pass
// cookie see.
export default async function GatedMembersPhotoModal({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div data-testid="gated-members-photo-modal">
      <p>Member photo {id} in modal</p>
    </div>
  );
}
