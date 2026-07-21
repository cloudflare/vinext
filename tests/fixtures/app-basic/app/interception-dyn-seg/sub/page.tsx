import Link from "next/link";

export default function Page() {
  return (
    <div id="sub-home">
      <Link href="/interception-dyn-seg/sub/target/42" id="link-sub-target-42">
        /sub/target/42
      </Link>
    </div>
  );
}
