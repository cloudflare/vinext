export function decodeHashFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    // Malformed percent escapes cannot be decoded; keep navigation alive and
    // attempt browser-style matching against the raw fragment.
    return fragment;
  }
}

export function scrollToHashTarget(hash: string): void {
  const fragment = decodeHashFragment(hash.startsWith("#") ? hash.slice(1) : hash);

  if (fragment === "" || fragment === "top") {
    window.scrollTo(0, 0);
    return;
  }

  const idElement = document.getElementById(fragment);
  if (idElement) {
    idElement.scrollIntoView({ behavior: "auto" });
    return;
  }

  document.getElementsByName(fragment)[0]?.scrollIntoView({ behavior: "auto" });
}

export function scrollToHashTargetOnNextFrame(hash: string): void {
  requestAnimationFrame(() => {
    scrollToHashTarget(hash);
  });
}

export function retryScrollTo(
  x: number,
  y: number,
  opts?: { shouldContinue?: () => boolean },
): void {
  const shouldContinue = opts?.shouldContinue ?? (() => true);
  let attempts = 0;
  const restore = () => {
    if (!shouldContinue()) return;
    window.scrollTo(x, y);
    if (!shouldContinue() || Math.abs(window.scrollY - y) <= 1 || attempts >= 60) {
      return;
    }
    attempts += 1;
    requestAnimationFrame(restore);
  };
  restore();
}
