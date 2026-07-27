/**
 * Side-effect polyfill import (the keyboard-focus slot in the app shell):
 * marks <body> once keyboard navigation is detected so CSS can scope focus
 * rings.
 */
if (typeof window !== "undefined") {
  const onFirstTab = (event: KeyboardEvent) => {
    if (event.key === "Tab") {
      document.body.dataset.keyboardUser = "true";
      window.removeEventListener("keydown", onFirstTab);
    }
  };
  window.addEventListener("keydown", onFirstTab);
}

export {};
