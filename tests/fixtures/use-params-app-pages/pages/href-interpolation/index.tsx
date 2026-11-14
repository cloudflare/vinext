import Link from "next/link";

// An empty leading param interpolates `/[id]/details` to `//details`.
export default function HrefInterpolationPage() {
  return (
    <main>
      <h1>Pages href interpolation</h1>
      <Link href={{ pathname: "/[id]/details", query: { id: "" } }} id="empty-param-link">
        Empty param
      </Link>
      <Link
        href={{ pathname: "/[id]/details", query: { id: "" } }}
        replace
        id="empty-param-replace-link"
      >
        Empty param (replace)
      </Link>
      <Link href={{ pathname: "/[id]/details", query: { id: "abc" } }} id="valid-param-link">
        Valid param
      </Link>
    </main>
  );
}
