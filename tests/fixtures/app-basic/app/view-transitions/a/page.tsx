import { ViewTransition } from "react";

export default function PageA() {
  return (
    <ViewTransition
      default="none"
      enter={{ "nav-forward": "slide-in", "nav-back": "slide-back-in", default: "page-enter" }}
      exit={{ "nav-forward": "slide-out", "nav-back": "slide-back-out", default: "page-exit" }}
    >
      <main data-testid="vt-page-a">
        <ViewTransition name="vt-shared-box" share="morph">
          <div style={{ width: 50, height: 50, background: "red" }} />
        </ViewTransition>
        Page A
      </main>
    </ViewTransition>
  );
}
