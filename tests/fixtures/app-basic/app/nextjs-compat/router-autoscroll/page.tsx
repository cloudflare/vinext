import Link from "next/link";

export default function RouterAutoscrollIndexPage() {
  return (
    <>
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>{index}</div>
      ))}
      <Link href="/nextjs-compat/router-autoscroll/focus-target" id="to-focus-target">
        To focus target
      </Link>
      <div>
        <Link href="/nextjs-compat/router-autoscroll/loading-scroll" id="to-loading-scroll">
          To loading scroll
        </Link>
      </div>
      <div>
        <Link href="/nextjs-compat/router-autoscroll/new-metadata" id="to-new-metadata">
          To new metadata
        </Link>
      </div>
      <div>
        <Link href="/nextjs-compat/router-autoscroll/hoisted" id="to-hoisted">
          To hoisted
        </Link>
      </div>
      <div>
        <Link
          href="/nextjs-compat/router-autoscroll/skipped-target/display-none"
          id="to-display-none-first-element"
        >
          To display none first element
        </Link>
      </div>
      <div>
        <Link
          href="/nextjs-compat/router-autoscroll/skipped-target/fixed"
          id="to-fixed-first-element"
        >
          To fixed first element
        </Link>
      </div>
      <div>
        <Link
          href="/nextjs-compat/router-autoscroll/skipped-target/sticky"
          id="to-sticky-first-element"
        >
          To sticky first element
        </Link>
      </div>
      <div style={{ height: 1, width: 10000 }} />
    </>
  );
}
