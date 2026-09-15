import Link from 'next/link';

export default function Page() {
  return (
    <Link id="prefetch-link" href="/prefetching/to-be-prefetched">
      link
    </Link>
  );
}
