import Link from "next/link";
import { connection } from "next/server";

export async function generateMetadata() {
  await connection();
  return { icons: { icon: "/star.png?v=sub" } };
}

export default function Page() {
  return (
    <Link id="metadata-icons-root-link" href="/metadata-icons-stream">
      Root icon
    </Link>
  );
}
