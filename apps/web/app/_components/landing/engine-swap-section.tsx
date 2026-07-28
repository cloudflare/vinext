import type { LandingStyle } from "./landing-styles";

export function EngineSwapSection() {
  return (
    <section
      id="swap"
      data-el="swapOuter"
      data-screen-label="The engine swap"
      style={
        {
          position: "relative",
          zIndex: "2",
          height: "115vh",
          // Overlap the hero's exit runway: its text is fully faded ~10vh into
          // the runway, after which the reader would scroll dead space before
          // this heading slid in. Starting the slide-in under that tail keeps
          // something always arriving. Hero exit progress is offsetHeight-based
          // in landing-motion, so the overlap doesn't change its timing.
          marginTop: "-15vh",
        } satisfies LandingStyle
      }
    >
      <div
        className="landing-viewport-height"
        style={
          {
            position: "sticky",
            top: "0",
            display: "flex",
            alignItems: "center",
            overflow: "hidden",
          } satisfies LandingStyle
        }
      >
        <div
          style={
            {
              maxWidth: "1180px",
              margin: "0 auto",
              padding: "0 32px",
              width: "100%",
              textAlign: "center",
            } satisfies LandingStyle
          }
        >
          <h2
            data-rv=""
            style={
              {
                opacity: "0",
                transform: "translateY(24px)",
                transition: "opacity var(--t),transform var(--t)",
                transitionDelay: ".06s",
                margin: "0",
                fontFamily: "'Geist',system-ui,sans-serif",
                fontWeight: "700",
                fontSize: "clamp(32px,5.4vw,64px)",
                lineHeight: "1.02",
                letterSpacing: "-.03em",
              } satisfies LandingStyle
            }
          >
            Start with the app you have.
          </h2>
          <p
            data-rv=""
            style={
              {
                opacity: "0",
                transform: "translateY(24px)",
                transition: "opacity var(--t),transform var(--t)",
                transitionDelay: ".12s",
                margin: "24px auto 0",
                maxWidth: "56ch",
                fontSize: "16px",
                lineHeight: "1.65",
                color: "var(--ink-sub)",
              } satisfies LandingStyle
            }
          >
            vinext keeps your app structure and maps supported{" "}
            <code
              style={
                {
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: ".85em",
                  background: "rgba(var(--ink-rgb),.06)",
                  padding: "1px 6px",
                  borderRadius: "5px",
                  color: "var(--orange-soft)",
                } satisfies LandingStyle
              }
            >
              next/*
            </code>{" "}
            APIs to Vite-compatible shims on{" "}
            <code
              style={
                {
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: ".85em",
                  background: "rgba(var(--ink-rgb),.06)",
                  padding: "1px 6px",
                  borderRadius: "5px",
                  color: "var(--orange-soft)",
                  whiteSpace: "nowrap",
                } satisfies LandingStyle
              }
            >
              @vitejs/plugin-rsc
            </code>
            .
          </p>
          <p
            data-rv=""
            style={
              {
                opacity: "0",
                transform: "translateY(24px)",
                transition: "opacity var(--t),transform var(--t)",
                transitionDelay: ".12s",
                margin: "12px auto 0",
                maxWidth: "56ch",
                fontSize: "16px",
                lineHeight: "1.65",
                color: "var(--ink-sub)",
              } satisfies LandingStyle
            }
          >
            Run{" "}
            <code
              style={
                {
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: ".85em",
                  background: "rgba(var(--ink-rgb),.06)",
                  padding: "1px 6px",
                  borderRadius: "5px",
                  color: "var(--orange-soft)",
                } satisfies LandingStyle
              }
            >
              npx vinext check
            </code>{" "}
            to flag known behavior gaps before migrating.
          </p>

          <div
            style={
              {
                marginTop: "48px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              } satisfies LandingStyle
            }
          >
            <div
              style={
                {
                  display: "flex",
                  gap: "16px",
                  justifyContent: "center",
                  flexWrap: "wrap",
                } satisfies LandingStyle
              }
            >
              <div
                style={
                  {
                    padding: "12px 20px",
                    border: "1px solid var(--line)",
                    borderRadius: "13px",
                    background: "rgba(var(--surface-rgb),.65)",
                    backdropFilter: "blur(6px)",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: "14px",
                    color: "var(--ink-sub)",
                  } satisfies LandingStyle
                }
              >
                app/
              </div>
              <div
                style={
                  {
                    padding: "12px 20px",
                    border: "1px solid var(--line)",
                    borderRadius: "13px",
                    background: "rgba(var(--surface-rgb),.65)",
                    backdropFilter: "blur(6px)",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: "14px",
                    color: "var(--ink-sub)",
                  } satisfies LandingStyle
                }
              >
                pages/
              </div>
              <div
                style={
                  {
                    padding: "12px 20px",
                    border: "1px solid var(--line)",
                    borderRadius: "13px",
                    background: "rgba(var(--surface-rgb),.65)",
                    backdropFilter: "blur(6px)",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: "14px",
                    color: "var(--ink-sub)",
                  } satisfies LandingStyle
                }
              >
                next.config.js
              </div>
            </div>
            <div
              style={
                {
                  marginTop: "12px",
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: "10.5px",
                  letterSpacing: ".16em",
                  textTransform: "uppercase",
                  color: "var(--mute)",
                } satisfies LandingStyle
              }
            >
              app structure · preserved
            </div>
            <div
              data-el="conn"
              style={
                {
                  width: "2px",
                  height: "48px",
                  margin: "16px 0",
                  background: "linear-gradient(180deg,rgba(var(--orange-rgb),.3),transparent)",
                  opacity: "1",
                } satisfies LandingStyle
              }
            />
            <div
              className="engine-plate is-swapped"
              data-el="plate"
              style={
                {
                  position: "relative",
                  // Floor is set by the "Vite" wordmark + lightning logo
                  // at the clamped 76px max: ~203px of ink + 64px padding.
                  // Below this the logo wraps onto the caption at wide
                  // viewports, so do not drop it without shrinking the mark.
                  minWidth: "min(285px,82vw)",
                  padding: "24px 32px",
                  border: "1px solid rgba(var(--orange-rgb),.12)",
                  borderRadius: "18px",
                  background:
                    "linear-gradient(180deg,rgba(var(--surface-rgb),.9),rgba(var(--surface-2-rgb),.9))",
                  boxShadow: "0 0 20px rgba(var(--orange-rgb),.05)",
                } satisfies LandingStyle
              }
            >
              <div
                style={
                  {
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: "10.5px",
                    letterSpacing: ".2em",
                    textTransform: "uppercase",
                    color: "var(--mute)",
                  } satisfies LandingStyle
                }
              >
                engine
              </div>
              <div
                style={
                  {
                    position: "relative",
                    height: "1.05em",
                    margin: "8px 0 4px",
                    fontFamily: "'Geist',system-ui,sans-serif",
                    fontWeight: "700",
                    // 1.1875 × the section h2 (5.4vw) so both hit their
                    // min/max at the same 593–1185px viewports and the
                    // plate:heading ratio stays constant while fluid.
                    fontSize: "clamp(38px,6.4vw,76px)",
                    letterSpacing: "-.03em",
                    lineHeight: "1",
                  } satisfies LandingStyle
                }
              >
                <span
                  data-el="plateGhost"
                  aria-hidden="true"
                  style={{ visibility: "hidden" } satisfies LandingStyle}
                >
                  Vite
                </span>
                <span
                  data-el="nextLabel"
                  style={
                    {
                      position: "absolute",
                      left: "0",
                      right: "0",
                      top: "0",
                      color: "var(--ink)",
                      opacity: "0",
                    } satisfies LandingStyle
                  }
                >
                  Turbopack
                </span>
                <span
                  data-el="viteLabel"
                  style={
                    {
                      position: "absolute",
                      left: "0",
                      right: "0",
                      top: "0",
                      color: "var(--orange)",
                      opacity: "1",
                      transform: "none",
                      textShadow: "0 0 50px var(--orange-glow)",
                    } satisfies LandingStyle
                  }
                >
                  Vite
                  <img
                    src="/img/vite-mark.svg"
                    alt=""
                    aria-hidden="true"
                    style={
                      {
                        display: "inline",
                        width: ".62em",
                        height: ".58em",
                        marginLeft: ".18em",
                        verticalAlign: "-.02em",
                      } satisfies LandingStyle
                    }
                  />
                </span>
              </div>
              <div
                data-el="plateSub"
                style={
                  {
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: "12px",
                    color: "var(--orange-soft)",
                    transition: "color .3s",
                  } satisfies LandingStyle
                }
              >
                vite + @vitejs/plugin-rsc
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
