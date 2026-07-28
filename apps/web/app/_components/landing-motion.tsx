"use client";

import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { getRaceFrame, type RaceFrame, type RaceSeconds } from "../lib/landing-race";
import {
  getLandingPlaybackStorage,
  hasLandingSequencePlayed,
  LANDING_RACE_PLAYED_KEY,
  LANDING_SWAP_PLAYED_KEY,
  markLandingSequencePlayed,
} from "../lib/landing-playback";

type RootRef = RefObject<HTMLDivElement | null>;
type CopyStatus = "copied" | "error";
type LandingElementName =
  | "conn"
  | "constellation"
  | "deployGrid"
  | "dcell"
  | "globe"
  | "hero"
  | "heroBg"
  | "heroBottom"
  | "heroTop"
  | "l1"
  | "l2"
  | "nextFill"
  | "nextjsDone"
  | "nextLabel"
  | "nextTime"
  | "payoff"
  | "plate"
  | "plateGhost"
  | "plateSub"
  | "raceOuter"
  | "swapOuter"
  | "vinextDone"
  | "vinextFill"
  | "vinextTime"
  | "viteLabel";

function findElement<T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  name: LandingElementName,
): T | null {
  return root.querySelector<T>(`[data-el="${name}"]`);
}

function findElements<T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  name: LandingElementName,
): T[] {
  return [...root.querySelectorAll<T>(`[data-el="${name}"]`)];
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot() {
  return window.matchMedia(reducedMotionQuery).matches;
}

function useReducedMotionPreference() {
  return useSyncExternalStore(subscribeToReducedMotion, getReducedMotionSnapshot, () => false);
}

function clamp(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smooth(value: number) {
  const clamped = clamp(value);
  return clamped * clamped * (3 - 2 * clamped);
}

function reveal(element: HTMLElement) {
  element.style.opacity = "1";
  element.style.transform = "none";
}

type RaceElements = {
  vinextFill: HTMLElement | null;
  nextFill: HTMLElement | null;
  vinextTime: HTMLElement | null;
  nextTime: HTMLElement | null;
  vinextDone: HTMLElement | null;
  nextjsDone: HTMLElement | null;
};

function findRaceElements(root: HTMLElement): RaceElements {
  return {
    vinextFill: findElement(root, "vinextFill"),
    nextFill: findElement(root, "nextFill"),
    vinextTime: findElement(root, "vinextTime"),
    nextTime: findElement(root, "nextTime"),
    vinextDone: findElement(root, "vinextDone"),
    nextjsDone: findElement(root, "nextjsDone"),
  };
}

function applyRaceFrame(elements: RaceElements, frame: RaceFrame, race: RaceSeconds) {
  const vinextText = `${frame.vinextTime.toFixed(1)}s`;
  const nextText = `${frame.nextjsTime.toFixed(1)}s`;
  const vinextTime = elements.vinextTime;
  const nextTime = elements.nextTime;
  if (vinextTime && vinextTime.textContent !== vinextText) vinextTime.textContent = vinextText;
  if (nextTime && nextTime.textContent !== nextText) nextTime.textContent = nextText;
  if (elements.vinextDone) {
    const opacity = frame.vinextDone && race.vinext < race.nextjs ? "1" : "0";
    if (elements.vinextDone.style.opacity !== opacity) elements.vinextDone.style.opacity = opacity;
  }
  if (elements.nextjsDone) {
    const opacity = frame.nextjsDone && race.nextjs < race.vinext ? "1" : "0";
    if (elements.nextjsDone.style.opacity !== opacity) elements.nextjsDone.style.opacity = opacity;
  }
}

function useMotionFoundation(reducedMotion: boolean) {
  useLayoutEffect(() => {
    if (reducedMotion) {
      document.documentElement.classList.remove("motion-ready");
      return;
    }
    document.documentElement.classList.add("motion-ready");
    return () => document.documentElement.classList.remove("motion-ready");
  }, [reducedMotion]);
}

function useIntroAndRevealMotion(rootRef: RootRef, reducedMotion: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const intro = [...root.querySelectorAll<HTMLElement>("[data-intro]")];
    const reveals = [...root.querySelectorAll<HTMLElement>("[data-rv]")];
    if (reducedMotion) {
      intro.forEach(reveal);
      reveals.forEach(reveal);
      return;
    }

    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => intro.forEach(reveal));
    });
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
          reveal(entry.target);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const element of reveals) {
      if (element.getBoundingClientRect().top < window.innerHeight * 0.92) reveal(element);
      else observer.observe(element);
    }

    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
      observer.disconnect();
    };
  }, [reducedMotion, rootRef]);
}

const constellationSources = {
  dark: "/img/hero-constellation-dark.avif",
  light: "/img/hero-constellation-light.avif",
} as const;

// Must mirror the min-width gate on .hero-constellation in globals.css:
// phones never fetch the artwork, so don't decode or prefetch there either.
const constellationMedia = "(min-width: 940px)";

// The CSS entrance (opacity/scale transition on [data-ready]) must never play
// over a half-loaded image, so the attribute flips only after the active
// theme's AVIF has decoded. Once revealed, the other theme's image is warmed
// during idle time so a theme toggle swaps instantly instead of popping
// whenever the network delivers.
function startConstellationReveal(constellation: HTMLElement): () => void {
  let dead = false;
  const media = window.matchMedia(constellationMedia);

  const begin = () => {
    media.removeEventListener("change", onMediaChange);
    const light = document.documentElement.getAttribute("data-theme") === "light";
    const image = new Image();
    image.src = light ? constellationSources.light : constellationSources.dark;
    image
      .decode()
      // Reveal on failure too: the layer just stays transparent, and keeping
      // it hidden forever would also suppress the prefetch below.
      .catch(() => {})
      .finally(() => {
        if (dead) return;
        constellation.setAttribute("data-ready", "");
        const prefetch = () => {
          if (!dead)
            new Image().src = light ? constellationSources.dark : constellationSources.light;
        };
        // Safari still lacks requestIdleCallback; a lazy timeout is close enough.
        if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(prefetch);
        else window.setTimeout(prefetch, 2500);
      });
  };
  // Widening a narrow window past the breakpoint makes CSS fetch the image;
  // without this listener the reveal would never fire and the hero would stay
  // blank until reload.
  const onMediaChange = () => {
    if (media.matches) begin();
  };

  if (media.matches) begin();
  else media.addEventListener("change", onMediaChange);

  return () => {
    dead = true;
    media.removeEventListener("change", onMediaChange);
  };
}

function useHeroMotion(rootRef: RootRef, reducedMotion: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const heroBg = findElement(root, "heroBg");
    if (reducedMotion) {
      if (heroBg) heroBg.style.opacity = "0";
      return;
    }

    const hero = findElement(root, "hero");
    const lineOne = findElement(root, "l1");
    const lineTwo = findElement(root, "l2");
    const heroTop = findElement(root, "heroTop");
    const heroBottom = findElement(root, "heroBottom");
    const globe = findElement(root, "globe");
    const deployGrid = findElement(root, "deployGrid");
    if (heroBg) heroBg.style.opacity = "1";

    const constellation = findElement(root, "constellation");
    const stopConstellation = constellation ? startConstellationReveal(constellation) : null;
    // The wrapper owns the one-shot entrance transition; scroll drift writes
    // go to the inner art div so the two transforms never retarget each other.
    const constellationArt =
      constellation?.firstElementChild instanceof HTMLElement
        ? constellation.firstElementChild
        : null;

    let frame: number | null = null;
    let lastNow = 0;
    let scrollY = window.scrollY;
    let previousScrollY = scrollY;
    let dead = false;

    const loop = (now: number) => {
      if (dead || document.hidden) {
        frame = null;
        return;
      }

      let delta = now - (lastNow || now);
      lastNow = now;
      if (delta <= 0 || delta > 100) delta = 16.7;
      const target = window.scrollY;
      scrollY += (target - scrollY) * (1 - Math.pow(0.86, delta / 16.7));
      if (Math.abs(target - scrollY) < 0.05) scrollY = target;
      const velocity = (scrollY - previousScrollY) * (16.7 / delta);
      previousScrollY = scrollY;
      const viewportHeight = window.innerHeight;

      let heroProgress = 0;
      if (hero) {
        heroProgress = clamp(scrollY / Math.max(1, hero.offsetHeight - viewportHeight));
        const eased = smooth(heroProgress);
        const distance = eased * window.innerWidth * 0.55;
        const opacity = String(Math.max(0, 1 - eased * eased * 1.15));
        const scale = `scale(${(1 - eased * 0.08).toFixed(4)})`;
        if (lineOne) {
          lineOne.style.transform = `translate3d(${-distance}px,0,0) ${scale}`;
          lineOne.style.opacity = opacity;
        }
        if (lineTwo) {
          lineTwo.style.transform = `translate3d(${distance}px,0,0) ${scale}`;
          lineTwo.style.opacity = opacity;
        }
        const fade = clamp(heroProgress * 1.6);
        const fadeOpacity = String(1 - fade);
        if (heroTop) {
          heroTop.style.opacity = fadeOpacity;
          heroTop.style.transform = `translate3d(0,${-fade * 70}px,0)`;
        }
        if (heroBottom) {
          heroBottom.style.opacity = fadeOpacity;
          heroBottom.style.transform = `translate3d(0,${fade * 70}px,0)`;
        }
      }

      if (globe && deployGrid) {
        const rect = deployGrid.getBoundingClientRect();
        const progress = clamp((viewportHeight - rect.top) / (viewportHeight + rect.height));
        globe.style.transform = `translate3d(0,${((0.5 - progress) * 70).toFixed(1)}px,0)`;
      }
      if (heroBg) {
        const progress = clamp(heroProgress * 1.15);
        heroBg.style.opacity = String(1 - progress * progress * (3 - 2 * progress));
      }
      if (constellationArt) {
        // Parallax: the artwork lifts slower than the content scrolling over
        // it. Lift is 2% of viewport height and the zoom is 4.5%, whose 2.25%
        // edge slack always covers the lift, so no background edge is exposed.
        const drift = smooth(heroProgress);
        constellationArt.style.transform = `translate3d(0,${(-drift * viewportHeight * 0.02).toFixed(1)}px,0) scale(${(1 + drift * 0.045).toFixed(4)})`;
      }

      if (Math.abs(target - scrollY) > 0.05 || Math.abs(velocity) > 0.01) {
        frame = requestAnimationFrame(loop);
      } else {
        frame = null;
      }
    };

    const wake = () => {
      if (dead || document.hidden || frame !== null) return;
      lastNow = performance.now();
      frame = requestAnimationFrame(loop);
    };
    const onVisibilityChange = () => {
      if (document.hidden && frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      } else {
        wake();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("scroll", wake, { passive: true });
    window.addEventListener("resize", wake, { passive: true });
    wake();
    return () => {
      dead = true;
      stopConstellation?.();
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("scroll", wake);
      window.removeEventListener("resize", wake);
    };
  }, [reducedMotion, rootRef]);
}

function useEngineSwapMotion(rootRef: RootRef, reducedMotion: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const outer = findElement(root, "swapOuter");
    const nextLabel = findElement(root, "nextLabel");
    const viteLabel = findElement(root, "viteLabel");
    const plate = findElement(root, "plate");
    const plateGhost = findElement(root, "plateGhost");
    const plateSub = findElement(root, "plateSub");
    const connector = findElement(root, "conn");
    const playbackStorage = getLandingPlaybackStorage();

    const applySwap = (progress: number) => {
      if (nextLabel) nextLabel.style.opacity = String(1 - Math.min(1, progress * 1.25));
      if (viteLabel) {
        viteLabel.style.opacity = String(Math.max(0, (progress - 0.15) / 0.85));
        viteLabel.style.transform = `translateY(${(1 - progress) * 44}px)`;
      }
      if (plateSub) {
        const swapped = progress > 0.5;
        plateSub.textContent = swapped ? "vite + @vitejs/plugin-rsc" : "next build · next.js 16";
        plateSub.style.color = swapped ? "var(--orange-soft)" : "var(--mute)";
      }
      if (connector) connector.style.opacity = String(0.3 + progress * 0.7);
    };
    const finish = () => {
      if (viteLabel) reveal(viteLabel);
      if (nextLabel) nextLabel.style.opacity = "0";
      plate?.classList.add("is-swapped");
      if (plateSub) {
        plateSub.textContent = "vite + @vitejs/plugin-rsc";
        plateSub.style.color = "var(--orange-soft)";
      }
      if (plateGhost) plateGhost.textContent = "Vite";
      if (connector) connector.style.opacity = "1";
    };
    const played = hasLandingSequencePlayed(playbackStorage, LANDING_SWAP_PLAYED_KEY);
    if (reducedMotion || played) {
      finish();
      return;
    }

    plate?.classList.remove("is-swapped");
    if (plateGhost) plateGhost.textContent = "Turbopack";
    if (nextLabel) nextLabel.style.opacity = "1";
    if (viteLabel) {
      viteLabel.style.opacity = "0";
      viteLabel.style.transform = "translateY(44px)";
    }
    if (plateSub) {
      plateSub.textContent = "next build · next.js 16";
      plateSub.style.color = "var(--mute)";
    }
    if (connector) connector.style.opacity = ".3";

    let animationFrame: number | null = null;
    let widthTimer: number | null = null;
    let started = false;
    let dead = false;
    const contractPlate = () => {
      if (!plate || !plateGhost) return;
      const initialWidth = plate.offsetWidth;
      plateGhost.textContent = "Vite";
      const finalWidth = plate.offsetWidth;
      if (finalWidth === initialWidth) return;
      plate.style.width = `${initialWidth}px`;
      void plate.offsetWidth;
      plate.style.transition = "width .6s var(--ease-out)";
      plate.style.width = `${finalWidth}px`;
      widthTimer = window.setTimeout(() => {
        plate.style.width = "";
        plate.style.transition = "";
      }, 700);
    };
    const run = () => {
      if (started) return;
      started = true;
      markLandingSequencePlayed(playbackStorage, LANDING_SWAP_PLAYED_KEY);
      plate?.classList.add("is-swapped");
      const start = performance.now();
      const step = (now: number) => {
        if (dead) return;
        const time = Math.min(1, (now - start) / 1100);
        applySwap(smooth(time));
        if (time < 1) animationFrame = requestAnimationFrame(step);
        else contractPlate();
      };
      animationFrame = requestAnimationFrame(step);
    };
    const check = () => {
      if (outer && outer.getBoundingClientRect().top < -window.innerHeight * 0.075) run();
    };

    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check, { passive: true });
    check();
    return () => {
      dead = true;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (widthTimer !== null) clearTimeout(widthTimer);
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [reducedMotion, rootRef]);
}

function useRaceMotion(rootRef: RootRef, race: RaceSeconds, reducedMotion: boolean) {
  const vinextSeconds = race.vinext;
  const nextjsSeconds = race.nextjs;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const raceOuter = findElement(root, "raceOuter");
    const payoff = findElement(root, "payoff");
    const elements = findRaceElements(root);
    const values = { vinext: vinextSeconds, nextjs: nextjsSeconds };
    const playbackStorage = getLandingPlaybackStorage();
    const played = hasLandingSequencePlayed(playbackStorage, LANDING_RACE_PLAYED_KEY);
    if (reducedMotion || played) {
      const finalFrame = getRaceFrame(values, 1);
      if (elements.vinextFill)
        elements.vinextFill.style.transform = `scaleX(${finalFrame.vinextFill})`;
      if (elements.nextFill) elements.nextFill.style.transform = `scaleX(${finalFrame.nextjsFill})`;
      applyRaceFrame(elements, finalFrame, values);
      if (payoff) reveal(payoff);
      return;
    }

    const initialFrame = getRaceFrame(values, 0);
    if (elements.vinextFill) elements.vinextFill.style.transform = "scaleX(0)";
    if (elements.nextFill) elements.nextFill.style.transform = "scaleX(0)";
    applyRaceFrame(elements, initialFrame, values);
    if (payoff) {
      payoff.style.opacity = "0";
      payoff.style.transform = "translateY(16px)";
    }

    let frame: number | null = null;
    let started = false;
    let dead = false;
    const barAnimations: Animation[] = [];
    const run = () => {
      if (started) return;
      started = true;
      markLandingSequencePlayed(playbackStorage, LANDING_RACE_PLAYED_KEY);
      const start = performance.now();
      const duration = getRaceFrame(values, 0).durationMs;
      const longest = Math.max(values.vinext, values.nextjs);
      const animateBar = (element: HTMLElement | null, seconds: number) => {
        if (!element) return;
        barAnimations.push(
          element.animate(
            [{ transform: "scaleX(0)" }, { transform: `scaleX(${seconds / longest})` }],
            {
              duration: duration * (seconds / longest),
              easing: "linear",
              fill: "forwards",
            },
          ),
        );
      };
      animateBar(elements.vinextFill, values.vinext);
      animateBar(elements.nextFill, values.nextjs);
      const step = (now: number) => {
        if (dead) return;
        const time = Math.min(1, (now - start) / duration);
        applyRaceFrame(elements, getRaceFrame(values, time), values);
        if (time < 1) frame = requestAnimationFrame(step);
        else if (payoff) reveal(payoff);
      };
      frame = requestAnimationFrame(step);
    };
    if (!raceOuter) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          run();
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -45% 0px" },
    );
    observer.observe(raceOuter);
    if (raceOuter.getBoundingClientRect().top < window.innerHeight * 0.55) run();

    return () => {
      dead = true;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      barAnimations.forEach((animation) => animation.cancel());
    };
  }, [nextjsSeconds, reducedMotion, rootRef, vinextSeconds]);
}

function illuminateDeploy(root: HTMLElement, instant: boolean) {
  const timers: number[] = [];
  root.querySelectorAll<HTMLElement>("[data-gpin]").forEach(reveal);
  findElements(root, "dcell").forEach((cell, index) => {
    const illuminate = () => {
      const name = cell.querySelector<HTMLElement>("[data-name]");
      const tag = cell.querySelector<HTMLElement>("[data-tag]");
      if (name) name.style.color = "var(--ink)";
      if (tag) tag.style.color = index === 0 ? "var(--orange-soft)" : "var(--ink-sub)";
    };
    if (instant) illuminate();
    else timers.push(window.setTimeout(illuminate, index * 110));
  });
  return () => timers.forEach(clearTimeout);
}

function useDeployMotion(rootRef: RootRef, reducedMotion: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const deployGrid = findElement(root, "deployGrid");
    const globe = findElement(root, "globe");
    if (reducedMotion) {
      illuminateDeploy(root, true);
      globe?.classList.add("tether-done");
      return;
    }
    if (!deployGrid) return;

    let stopTimers = () => {};
    let started = false;
    const run = () => {
      if (started) return;
      started = true;
      stopTimers = illuminateDeploy(root, false);
      globe?.classList.add("tether-run");
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          run();
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    observer.observe(deployGrid);
    if (deployGrid.getBoundingClientRect().top < window.innerHeight * 0.8) run();

    return () => {
      observer.disconnect();
      stopTimers();
    };
  }, [reducedMotion, rootRef]);
}

function useCopyCommand(rootRef: RootRef) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let resetTimer: number | null = null;
    const setStatus = (button: HTMLButtonElement, state: CopyStatus, label: string) => {
      if (resetTimer !== null) clearTimeout(resetTimer);
      const idleLabel = (button.dataset.copyIdleLabel ??=
        button.getAttribute("aria-label") ?? "Copy command");
      button.setAttribute("data-copy-state", state);
      button.setAttribute("aria-label", label);
      resetTimer = window.setTimeout(() => {
        button.removeAttribute("data-copy-state");
        button.setAttribute("aria-label", idleLabel);
      }, 1500);
    };
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("[data-copy]");
      if (!(button instanceof HTMLButtonElement) || !root.contains(button)) return;
      const text = button.dataset.copy;
      if (!text) return;

      if (!navigator.clipboard?.writeText) {
        setStatus(button, "error", "Copy command failed");
        return;
      }
      Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Clipboard write timed out")), 800);
        }),
      ]).then(
        () => setStatus(button, "copied", "Command copied"),
        () => setStatus(button, "error", "Copy command failed"),
      );
    };

    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("click", onClick);
      if (resetTimer !== null) clearTimeout(resetTimer);
    };
  }, [rootRef]);
}

type LandingMotionProps = {
  children: ReactNode;
  race: RaceSeconds;
  style: CSSProperties;
};

export function LandingMotion({ children, race, style }: LandingMotionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotionPreference();
  useMotionFoundation(reducedMotion);
  useIntroAndRevealMotion(rootRef, reducedMotion);
  useHeroMotion(rootRef, reducedMotion);
  useEngineSwapMotion(rootRef, reducedMotion);
  useRaceMotion(rootRef, race, reducedMotion);
  useDeployMotion(rootRef, reducedMotion);
  useCopyCommand(rootRef);

  return (
    <div ref={rootRef} id="app" className="landing-root" style={style}>
      {children}
    </div>
  );
}
