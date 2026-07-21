"use client";

import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";

export default function ShallowHistoryTargetPage() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <>
      <h1>Shallow history target</h1>
      <pre id="shallow-pathname">{pathname}</pre>
      <button
        id="push-shallow-pathname"
        onClick={() => {
          const url = new URL(window.location.href);
          url.pathname = "/nextjs-compat/shallow-history/missing";
          window.history.pushState({}, "", url);
        }}
      >
        Push pathname
      </button>
      <button
        id="supersede-rsc-navigation"
        onClick={() => {
          router.push("/nextjs-compat/shallow-history/slow");
          window.history.pushState({}, "", "/nextjs-compat/shallow-history/missing");
        }}
      >
        Supersede RSC navigation
      </button>
      <button
        id="replace-during-rsc-navigation"
        onClick={() => {
          router.push("/nextjs-compat/shallow-history");
          window.history.replaceState({}, "", "/nextjs-compat/shallow-history/replaced");
        }}
      >
        Replace during RSC navigation
      </button>
      <button
        id="state-only-replace-during-rsc-navigation"
        onClick={() => {
          router.push("/nextjs-compat/shallow-history");
          window.setTimeout(() => window.history.replaceState({ marker: true }, ""), 50);
        }}
      >
        State-only replace during RSC navigation
      </button>
      <button
        id="reject-shallow-history"
        onClick={() => {
          router.push("/nextjs-compat/shallow-history");
          window.setTimeout(() => {
            try {
              window.history.pushState(
                { invalid: () => {} },
                "",
                "/nextjs-compat/shallow-history/missing",
              );
            } catch {}
          }, 50);
        }}
      >
        Reject shallow history
      </button>
      <button
        id="start-rsc-navigation"
        onClick={() => router.push("/nextjs-compat/shallow-history")}
      >
        Start RSC navigation
      </button>
    </>
  );
}
