import Link from "next/link";

export default function Page() {
  return (
    <div id="home">
      <ul>
        <li>
          <Link href="/interception-dyn-seg/foo/1" id="link-foo-1">
            /foo/1
          </Link>
        </li>
        <li>
          <Link href="/interception-dyn-seg/test-nested" id="link-test-nested">
            /test-nested
          </Link>
        </li>
        <li>
          <Link href="/interception-dyn-seg/test-nested/deeper" id="link-test-nested-deeper">
            /test-nested/deeper
          </Link>
        </li>
      </ul>
    </div>
  );
}
