/**
 * Test fixture: sibling intercepts under the "%s | Layout" template. A
 * plain-string layout in the intercepting page's own directory doesn't clear
 * the template for that page; one above it does.
 */
import Link from "next/link";

export default function Page() {
  return (
    <div id="title-template-intercept-source">
      <Link href="/nextjs-compat/metadata-title-template/intercept/photo/1">Photo 1</Link>
      <Link href="/nextjs-compat/metadata-title-template/intercept/framed/1">Framed 1</Link>
    </div>
  );
}
