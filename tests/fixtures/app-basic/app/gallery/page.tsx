import Link from "next/link";

export default function GalleryPage() {
  return (
    <div data-testid="gallery-page">
      <h1>Photo Gallery</h1>
      <ul>
        <li>
          <Link href="/photos/42" id="gallery-photo-42-link">
            Photo 42
          </Link>
        </li>
      </ul>
    </div>
  );
}
