import Link from "next/link";

export default function LinkToRewrittenPathPage() {
  return (
    <Link href="/exists-but-not-routed" id="link-to-rewritten-path">
      Exists but not routed
    </Link>
  );
}
