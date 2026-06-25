import Link from "next/link";

export default function MetadataIconsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="icon" href="/manual-icon.svg" data-manual-icon="" />
      <link rel="shortcut icon" href="/manual-shortcut.png" data-manual-icon="" />
      <link rel="mask-icon" href="/manual-mask.svg" data-manual-icon="" />
      <nav>
        <Link id="metadata-icons-heart" href="/metadata-icons-stream/heart">
          Heart
        </Link>
        <Link id="metadata-icons-star" href="/metadata-icons-stream/star">
          Star
        </Link>
        <Link id="metadata-icons-none" href="/metadata-icons-stream/none">
          None
        </Link>
      </nav>
      {children}
    </>
  );
}
