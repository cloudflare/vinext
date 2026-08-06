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

  const namedElement = document.getElementsByName(fragment)[0];
  if (namedElement) {
    namedElement.scrollIntoView({ behavior: "auto" });
    return;
  }

  window.scrollTo(0, 0);
}

export function scrollToHashTargetOnNextFrame(hash: string, shouldScroll?: () => boolean): void {
  requestAnimationFrame(() => {
    if (shouldScroll && !shouldScroll()) return;
    scrollToHashTarget(hash);
  });
}

export function retryScrollTo(
  x: number,
  y: number,
  opts?: { minFrames?: number; shouldContinue?: () => boolean },
): void {
  const minFrames = opts?.minFrames ?? 0;
  const shouldContinue = opts?.shouldContinue ?? (() => true);
  let attempts = 0;
  const restore = () => {
    if (!shouldContinue()) return;
    window.scrollTo(x, y);
    const reachedTarget = Math.abs(window.scrollY - y) <= 1;
    if (!shouldContinue() || (reachedTarget && attempts >= minFrames) || attempts >= 60) {
      return;
    }
    attempts += 1;
    requestAnimationFrame(restore);
  };
  restore();
}
