import Link from "next/link";
import { BRAND } from "./brand";

// next/link shares vinext's runtime helpers with the client entry.
export function HomeLink() {
  return <Link href="/">{BRAND}</Link>;
}
