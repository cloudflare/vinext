import type { LandingStyle } from "./landing-styles";

// Soft light sources placed down the whole page. heroBg (below) owns the hero's
// peak glow and fades on scroll; past it the page used to drop to flat --bg,
// which is what made the lower sections read as slides in a void. These live in
// a page-height layer so each section scrolls through its own pool of light and
// the warm/cool rhythm from the hero keeps going. top is % of the full page.
const groundGlows: ReadonlyArray<{
  top: string;
  left: string;
  size: string;
  rgb: string;
  alpha: number;
}> = [
  { top: "30%", left: "72%", size: "82vmax", rgb: "--orange-rgb", alpha: 0.07 },
  { top: "52%", left: "14%", size: "96vmax", rgb: "--aur2-rgb", alpha: 0.11 },
  { top: "74%", left: "80%", size: "70vmax", rgb: "--orange-rgb", alpha: 0.06 },
  { top: "90%", left: "28%", size: "88vmax", rgb: "--aur2-rgb", alpha: 0.09 },
];

export function LandingAtmosphere() {
  return (
    <>
      {/* Persistent ground: never fades, sits behind the z-2 content. Gives the
          whole scroll a continuous, lit, faintly-structured surface instead of
          flat black between sections. */}
      <div
        aria-hidden="true"
        style={
          {
            position: "absolute",
            inset: "0",
            zIndex: "0",
            pointerEvents: "none",
            overflow: "hidden",
          } satisfies LandingStyle
        }
      >
        {/* Barely-there dot field — reads as a designed surface, not a grid.
            --ink-rgb flips with theme (light dots on dark / dark on paper), and
            the vertical mask keeps it clear of the chrome and the footer edge. */}
        <div
          style={
            {
              position: "absolute",
              inset: "0",
              backgroundImage: "radial-gradient(rgba(var(--ink-rgb),.5) 1px,transparent 1px)",
              backgroundSize: "38px 38px",
              opacity: ".045",
              maskImage: "linear-gradient(180deg,transparent 0,#000 7%,#000 93%,transparent 100%)",
              WebkitMaskImage:
                "linear-gradient(180deg,transparent 0,#000 7%,#000 93%,transparent 100%)",
            } satisfies LandingStyle
          }
        />
        {groundGlows.map((glow) => (
          <div
            key={`${glow.rgb}${glow.top}`}
            style={
              {
                position: "absolute",
                top: glow.top,
                left: glow.left,
                width: glow.size,
                height: glow.size,
                margin: `calc(${glow.size} / -2) 0 0 calc(${glow.size} / -2)`,
                background: `radial-gradient(closest-side,rgba(var(${glow.rgb}),${glow.alpha}),rgba(var(${glow.rgb}),${(glow.alpha * 0.36).toFixed(3)}) 45%,transparent 70%)`,
              } satisfies LandingStyle
            }
          />
        ))}
      </div>

      <div
        aria-hidden="true"
        style={
          {
            position: "fixed",
            inset: "0",
            zIndex: "70",
            pointerEvents: "none",
            opacity: ".05",
            mixBlendMode: "overlay",
            backgroundImage: 'url("/img/icon-01.svg")',
          } satisfies LandingStyle
        }
      />

      {/* Static atmosphere. These blobs used to drift on 47–61s infinite
            alternating keyframes; three full-viewport gradients repainting
            forever bought no meaning, so only the scroll-linked fade remains. */}
      <div
        data-el="heroBg"
        aria-hidden="true"
        style={
          {
            position: "fixed",
            inset: "0",
            zIndex: "0",
            opacity: "0",
            pointerEvents: "none",
            overflow: "hidden",
          } satisfies LandingStyle
        }
      >
        <div
          style={
            {
              position: "absolute",
              left: "64%",
              top: "8%",
              width: "90vmax",
              height: "90vmax",
              margin: "-45vmax 0 0 -45vmax",
              background:
                "radial-gradient(closest-side,rgba(var(--orange-rgb),.13),rgba(var(--orange-rgb),.05) 42%,transparent 68%)",
            } satisfies LandingStyle
          }
        />
        <div
          style={
            {
              position: "absolute",
              left: "18%",
              top: "80%",
              width: "110vmax",
              height: "110vmax",
              margin: "-55vmax 0 0 -55vmax",
              background:
                "radial-gradient(closest-side,rgba(var(--aur2-rgb),.17),rgba(var(--aur2-rgb),.07) 45%,transparent 70%)",
            } satisfies LandingStyle
          }
        />
        <div
          style={
            {
              position: "absolute",
              left: "83%",
              top: "72%",
              width: "60vmax",
              height: "60vmax",
              margin: "-30vmax 0 0 -30vmax",
              background: "radial-gradient(closest-side,rgba(251,173,65,.07),transparent 65%)",
            } satisfies LandingStyle
          }
        />
        <div
          style={
            {
              position: "absolute",
              inset: "0",
              background:
                "radial-gradient(120% 100% at 50% 45%,transparent 44%,rgba(var(--bg-rgb),.66) 100%)",
            } satisfies LandingStyle
          }
        />
        {/* Constellation artwork. Styled entirely in globals.css: the image
            URLs must live in a min-width media query so phones never download
            them, which inline styles can't express. The wrapper owns the
            decode-gated entrance (landing-motion flips data-ready once the
            AVIF has decoded); the inner div carries the image and the
            per-frame scroll drift. Keep this the last child — the
            light-theme rule dimming the aurora blobs targets
            div:nth-child(-n + 3). */}
        <div data-el="constellation" className="hero-constellation">
          <div className="hero-constellation-art" />
        </div>
      </div>
    </>
  );
}
