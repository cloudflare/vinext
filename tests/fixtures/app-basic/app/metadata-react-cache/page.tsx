import Link from "next/link";

export default function Page() {
  return (
    <ul>
      <li>
        <Link href="/metadata-react-cache/viewport" id="viewport-link">
          viewport
        </Link>
      </li>
      <li>
        <Link href="/metadata-react-cache/connection" id="connection-link">
          connection
        </Link>
      </li>
      <li>
        <Link href="/metadata-react-cache/cache-signal" id="cache-signal-link">
          cacheSignal
        </Link>
      </li>
    </ul>
  );
}
