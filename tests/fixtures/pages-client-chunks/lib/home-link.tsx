import Link from "next/link";
import { BRAND } from "./brand";
// A side-effect-free barrel that pages import from too.
import { kitTitle } from "./kit";

// next/link shares vinext's runtime helpers with the client entry.
export function HomeLink() {
  return <Link href="/">{kitTitle(BRAND)}</Link>;
}
