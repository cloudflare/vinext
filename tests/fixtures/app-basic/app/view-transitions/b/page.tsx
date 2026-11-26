import { ViewTransition } from "react";

export default function PageB() {
  return (
    <ViewTransition
      default="none"
      enter={{ "nav-forward": "slide-in", "nav-back": "slide-back-in", default: "page-enter" }}
      exit={{ "nav-forward": "slide-out", "nav-back": "slide-back-out", default: "page-exit" }}
    >
      <main data-testid="vt-page-b">Page B</main>
    </ViewTransition>
  );
}
