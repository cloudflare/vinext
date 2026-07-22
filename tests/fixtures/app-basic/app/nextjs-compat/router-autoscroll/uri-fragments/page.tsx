import Link from "next/link";

export default function UriFragmentsPage() {
  return (
    <>
      <nav aria-label="Table of contents">
        <ol>
          <li>
            <Link href="#section-1" id="to-section-1">
              Section 1
            </Link>
          </li>
          <li>
            <Link href="#section-2" id="to-section-2">
              Section 2
            </Link>
          </li>
          <li>
            <Link href="#section-3" id="to-section-3">
              Section 3
            </Link>
          </li>
          <li>
            <Link href="#svg-target" id="to-svg-target">
              SVG target
            </Link>
          </li>
        </ol>
      </nav>

      <article style={{ height: "50vh", overflow: "scroll" }}>
        <h1>A post</h1>
        <p style={{ height: "100vh" }}>Some long intro</p>
        <h2 id="section-1">Section 1</h2>
        <p style={{ height: "100vh" }}>Section 1 body</p>
        <h2 id="section-2">Section 2</h2>
        <p style={{ height: "100vh" }}>Section 2 body</p>
        <h2 id="section-3">Section 3</h2>
        <p style={{ height: "100vh" }}>Section 3 body</p>
        <svg id="svg-target" height="20" width="20" aria-label="SVG hash target" />
        <button id="after-svg-target" type="button">
          After SVG target
        </button>
      </article>
    </>
  );
}
