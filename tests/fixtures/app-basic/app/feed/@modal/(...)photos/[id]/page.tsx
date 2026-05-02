import Link from "next/link";
import { getPhotoLikes } from "./actions";
import { LikeButton } from "./like-button";
import { PhotoModalRefreshButton } from "./refresh-button";

// Intercepting route: renders when navigating from /feed to /photos/[id].
// Shows a modal version of the photo instead of the full page.
export default async function PhotoModal({ params }: { params: { id: string } }) {
  const initialLikes = await getPhotoLikes(params.id);

  return (
    <div data-testid="photo-modal">
      <h2>Photo Modal</h2>
      <p>Viewing photo {params.id} in modal</p>
      <Link href="/photos/43" id="modal-photo-43-link">
        Next Photo
      </Link>
      <PhotoModalRefreshButton />
      <LikeButton id={params.id} initialLikes={initialLikes} />
    </div>
  );
}
