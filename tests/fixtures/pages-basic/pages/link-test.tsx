import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";

export default function LinkTestPage() {
  const router = useRouter();
  const [preventedNav, setPreventedNav] = useState(false);

  return (
    <div>
      <h1>Link Advanced Props Test</h1>

      {/* Tall content to enable scroll testing */}
      <div style={{ height: "200vh", background: "linear-gradient(white, #eee)" }}>
        <p>Tall content area</p>
      </div>

      <div data-testid="links" style={{ marginTop: 20 }}>
        {/* scroll={false} - should preserve scroll position */}
        <Link href="/about" scroll={false} data-testid="link-no-scroll">
          No Scroll Link
        </Link>

        {/* replace - should not add history entry */}
        <Link href="/about" replace data-testid="link-replace">
          Replace Link
        </Link>

        {/* as prop - legacy href/as pattern */}
        <Link href="/blog/[slug]" as="/blog/test-post" data-testid="link-as">
          As Prop Link
        </Link>

        {/* onClick with preventDefault */}
        <Link
          href="/about"
          data-testid="link-prevent"
          onClick={(e) => {
            e.preventDefault();
            setPreventedNav(true);
          }}
        >
          Prevented Link
        </Link>

        {/* target="_blank" */}
        <Link href="/about" target="_blank" data-testid="link-blank">
          Blank Target Link
        </Link>
      </div>

      {preventedNav && <div data-testid="prevented-message">Navigation was prevented</div>}

      <div data-testid="current-path">{router.asPath}</div>
    </div>
  );
}
