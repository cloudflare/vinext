import Link from "next/link";
import { SourceState } from "./source-state";

export default function Page() {
  return (
    <div>
      <SourceState />
      {/* Link without locale — middleware rewrites /interception-mw/foo/p/1
          to /interception-mw/en/foo/p/1, then the Referer-based interception
          fallback fires so the modal slot shows the intercepted page. */}
      <Link href="/interception-mw/foo/p/1" id="link-foo-p-1">
        Foo
      </Link>
    </div>
  );
}
