import Link from "next/link";
import { ActionControls } from "./action-controls";
import { recordActionRun } from "./action-log";
import { VERSION } from "./version";

export default function HomePage() {
  const secret = `secret-${VERSION}`;

  async function bound() {
    "use server";
    await recordActionRun("bound");
    return `bound:${secret}`;
  }

  return (
    <main>
      <h1 id="version">{`Version ${VERSION}`}</h1>
      <input id="draft" defaultValue="" />
      <ActionControls bound={bound} />
      <nav>
        <Link href="/client-target" id="client-link" prefetch={false}>
          Client target
        </Link>
        <Link href="/eval-target" id="eval-link" prefetch={false}>
          Evaluation failure target
        </Link>
        <Link href="/other" id="other-link" prefetch={false}>
          Other
        </Link>
        <Link href="/attachment" id="csv-link" prefetch={false}>
          Export CSV
        </Link>
        <a href="/slow-doc" id="slow-link">
          Slow document
        </a>
      </nav>
      <div style={{ height: 3000 }} />
      <Link href="/prefetch-target" id="prefetch-link">
        Prefetched target
      </Link>
    </main>
  );
}
