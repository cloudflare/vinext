import type { LandingStyle } from "./landing-styles";
import { CopyButton } from "./copy-button";

export function HeroSection() {
  return (
    <section
      id="hero"
      data-el="hero"
      data-screen-label="Hero"
      style={{ position: "relative", zIndex: "2", height: "115vh" } satisfies LandingStyle}
    >
      <div
        className="landing-viewport-height"
        style={
          {
            position: "sticky",
            top: "0",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "0 24px",
            overflow: "hidden",
          } satisfies LandingStyle
        }
      >
        <div data-el="heroTop" style={{ willChange: "transform,opacity" } satisfies LandingStyle} />
        <h1
          style={
            {
              margin: "0",
              fontFamily: "'Geist',system-ui,sans-serif",
              fontWeight: "700",
              fontSize: "clamp(58px,11.5vw,178px)",
              lineHeight: ".9",
              letterSpacing: "-.045em",
              color: "var(--ink)",
            } satisfies LandingStyle
          }
        >
          {/* h1 allows phrasing content only, so the motion wrappers are
              display:block spans rather than divs. */}
          <span
            data-el="l1"
            style={{ display: "block", willChange: "transform,opacity" } satisfies LandingStyle}
          >
            <span
              data-intro=""
              style={
                {
                  display: "block",
                  opacity: "0",
                  transform: "translateY(50px)",
                  transition: "opacity 1s var(--ease-out) .2s,transform 1s var(--ease-out) .2s",
                } satisfies LandingStyle
              }
            >
              Run Next.js
            </span>
          </span>
          <span
            data-el="l2"
            style={{ display: "block", willChange: "transform,opacity" } satisfies LandingStyle}
          >
            <span
              data-intro=""
              style={
                {
                  display: "block",
                  opacity: "0",
                  transform: "translateY(50px)",
                  transition: "opacity 1s var(--ease-out) .34s,transform 1s var(--ease-out) .34s",
                } satisfies LandingStyle
              }
            >
              <span style={{ color: "var(--mute)" } satisfies LandingStyle}>on</span>{" "}
              <span
                style={
                  {
                    color: "var(--orange)",
                    textShadow: "0 0 80px var(--orange-glow)",
                  } satisfies LandingStyle
                }
              >
                Vite.
              </span>
            </span>
          </span>
        </h1>
        <div
          data-el="heroBottom"
          style={
            {
              willChange: "transform,opacity",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            } satisfies LandingStyle
          }
        >
          <p
            data-intro=""
            style={
              {
                opacity: "0",
                transform: "translateY(26px)",
                transition: "opacity .9s var(--ease-out) .5s,transform .9s var(--ease-out) .5s",
                margin: "42px 0 0",
                maxWidth: "54ch",
                fontSize: "17.5px",
                lineHeight: "1.6",
                color: "var(--sub)",
              } satisfies LandingStyle
            }
          >
            Keep your app structure.
            <br />
            Faster dev loop, smaller bundles, deploy anywhere.
          </p>
          {/* The page's one ask, reachable without scrolling. The deploy
              section owns the platform-logo story; repeating it here spent
              the hero's last slot on decoration. Same [data-copy] contract
              as the get-started box, sized down to whisper. */}
          <div
            data-intro=""
            style={
              {
                opacity: "0",
                transform: "translateY(26px)",
                transition: "opacity .9s var(--ease-out) .62s,transform .9s var(--ease-out) .62s",
                marginTop: "56px",
                display: "flex",
                alignItems: "center",
                gap: "14px",
                padding: "10px 10px 10px 18px",
                border: "1px solid var(--line)",
                borderRadius: "13px",
                background: "rgba(var(--surface-rgb),.65)",
                backdropFilter: "blur(6px)",
              } satisfies LandingStyle
            }
          >
            <span
              aria-hidden="true"
              style={
                {
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: "13px",
                  color: "var(--mute)",
                } satisfies LandingStyle
              }
            >
              $
            </span>
            <code
              style={
                {
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: "13.5px",
                  letterSpacing: "-.01em",
                  color: "var(--ink)",
                } satisfies LandingStyle
              }
            >
              npx vinext init
            </code>
            <CopyButton value="npx vinext init" ariaLabel="Copy command" />
          </div>
        </div>
      </div>
    </section>
  );
}
