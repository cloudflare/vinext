import Link from "next/link";

const BASE = "/nextjs-compat/parallel-routes-scroll-owner/modal";

const fixedLink = (top: number) =>
  ({ position: "fixed", top, right: 20, padding: 12, background: "white" }) as const;

export default function Page() {
  return (
    <div id="modal-page" style={{ minHeight: 3200 }}>
      <h1>Modal page</h1>
      <input id="focus-target" aria-label="Focus target" />
      <Link id="open-empty-modal" href={`${BASE}/open`} style={fixedLink(20)}>
        Open empty modal
      </Link>
      <Link
        id="open-modal-missing-hash"
        href={`${BASE}/visible#missing-target`}
        style={fixedLink(80)}
      >
        Open visible modal with missing hash
      </Link>
      <Link
        id="open-empty-modal-real-hash"
        href={`${BASE}/open#hash-target`}
        style={fixedLink(140)}
      >
        Open empty modal with real hash
      </Link>
      <div id="hash-target" style={{ marginTop: 1800 }}>
        Hash target
      </div>
    </div>
  );
}
