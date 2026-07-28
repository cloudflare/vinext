import type { LandingStyle } from "./landing-styles";

type DeployIcon = "aws" | "cloudflare" | "deno" | "netlify" | "node" | "vercel";
type DeployTarget = { name: string; icon: DeployIcon; status: "adapter" | "first-class" };

const deployTargets = [
  { name: "Cloudflare Workers", icon: "cloudflare", status: "first-class" },
  { name: "Vercel", icon: "vercel", status: "adapter" },
  { name: "Netlify", icon: "netlify", status: "adapter" },
  { name: "AWS Lambda", icon: "aws", status: "adapter" },
  { name: "Deno Deploy", icon: "deno", status: "adapter" },
  { name: "Node (standalone)", icon: "node", status: "adapter" },
] satisfies readonly DeployTarget[];

function DeployIcon({ icon }: { icon: DeployIcon }) {
  if (icon === "cloudflare" || icon === "netlify" || icon === "node") {
    const em = icon === "netlify" ? "1.3em" : "1.4em";
    return (
      <img
        src={`/img/brand-${icon === "node" ? "nodedotjs" : icon}.svg`}
        alt=""
        aria-hidden="true"
        style={
          {
            width: em,
            height: em,
            marginRight: "0.8em",
            verticalAlign: "-0.3em",
          } satisfies LandingStyle
        }
      />
    );
  }
  if (icon === "aws") {
    return (
      <span
        aria-hidden="true"
        style={
          {
            display: "inline-flex",
            width: "1.4em",
            marginRight: "0.8em",
            justifyContent: "center",
            alignItems: "baseline",
          } satisfies LandingStyle
        }
      >
        <span
          style={{ fontSize: "1.3em", fontWeight: "600", color: "#ff9900" } satisfies LandingStyle}
        >
          λ
        </span>
      </span>
    );
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={
        {
          width: icon === "vercel" ? "1.25em" : "1.3em",
          height: icon === "vercel" ? "1.25em" : "1.3em",
          marginRight: "0.8em",
          verticalAlign: icon === "vercel" ? "-0.22em" : "-0.3em",
        } satisfies LandingStyle
      }
    >
      <path
        d={
          icon === "vercel"
            ? "m12 1.608 12 20.784H0Z"
            : "M1.105 18.02A11.9 11.9 0 0 1 0 12.985q0-.698.078-1.376a12 12 0 0 1 .231-1.34A12 12 0 0 1 4.025 4.02a12 12 0 0 1 5.46-2.771 12 12 0 0 1 3.428-.23c1.452.112 2.825.477 4.077 1.05a12 12 0 0 1 2.78 1.774 12.02 12.02 0 0 1 4.053 7.078A12 12 0 0 1 24 12.985q0 .454-.036.914a12 12 0 0 1-.728 3.305 12 12 0 0 1-2.38 3.875c-1.33 1.357-3.02 1.962-4.43 1.936a4.4 4.4 0 0 1-2.724-1.024c-.99-.853-1.391-1.83-1.53-2.919a5 5 0 0 1 .128-1.518c.105-.38.37-1.116.76-1.437-.455-.197-1.04-.624-1.226-.829-.045-.05-.04-.13 0-.183a.155.155 0 0 1 .177-.053c.392.134.869.267 1.372.35.66.111 1.484.25 2.317.292 2.03.1 4.153-.813 4.812-2.627s.403-3.609-1.96-4.685-3.454-2.356-5.363-3.128c-1.247-.505-2.636-.205-4.06.582-3.838 2.121-7.277 8.822-5.69 15.032a.191.191 0 0 1-.315.19 12 12 0 0 1-1.25-1.634 12 12 0 0 1-.769-1.404M11.57 6.087c.649-.051 1.214.501 1.31 1.236.13.979-.228 1.99-1.41 2.013-1.01.02-1.315-.997-1.248-1.614.066-.616.574-1.575 1.35-1.635"
        }
      />
    </svg>
  );
}

function DeployTargetRow({ target, isLast }: { target: DeployTarget; isLast: boolean }) {
  return (
    <div
      data-el="dcell"
      style={
        {
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "16px",
          padding: "12px 2px",
          borderTop: "1px solid var(--line-soft)",
          borderBottom: isLast ? "1px solid var(--line-soft)" : undefined,
        } satisfies LandingStyle
      }
    >
      <span
        data-name=""
        style={{ color: "var(--sub)", transition: "color .5s" } satisfies LandingStyle}
      >
        <DeployIcon icon={target.icon} />
        {target.name}
      </span>
      <span
        data-tag=""
        style={
          {
            color: target.status === "first-class" ? "var(--ok)" : "var(--mute)",
            transition: "color .5s",
          } satisfies LandingStyle
        }
      >
        {target.status}
      </span>
    </div>
  );
}

export function DeploySection() {
  return (
    <section
      id="deploy"
      data-screen-label="Deploy anywhere"
      style={
        {
          position: "relative",
          zIndex: "2",
          padding: "96px 0",
          overflow: "hidden",
        } satisfies LandingStyle
      }
    >
      <div
        className="deploy-inner"
        style={
          {
            position: "relative",
            maxWidth: "1180px",
            margin: "0 auto",
            padding: "0 32px",
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
              lineHeight: "1.03",
              letterSpacing: "-.03em",
            } satisfies LandingStyle
          }
        >
          <span style={{ color: "var(--orange)" } satisfies LandingStyle}>Deploy anywhere.</span>
        </h2>
        <p
          data-rv=""
          style={
            {
              opacity: "0",
              transform: "translateY(24px)",
              transition: "opacity var(--t),transform var(--t)",
              transitionDelay: ".12s",
              margin: "24px 0 0",
              maxWidth: "52ch",
              fontSize: "16.5px",
              lineHeight: "1.65",
              color: "var(--ink-sub)",
            } satisfies LandingStyle
          }
        >
          vinext emits a standard server build. Cloudflare Workers is first-class; everything else
          runs through Nitro adapters.
        </p>

        <div
          data-el="deployGrid"
          data-rv=""
          style={
            {
              opacity: "0",
              transform: "translateY(24px)",
              transition: "opacity var(--t),transform var(--t)",
              transitionDelay: ".16s",
              marginTop: "48px",
              maxWidth: "520px",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: "13.5px",
            } satisfies LandingStyle
          }
        >
          <div
            style={
              {
                display: "flex",
                justifyContent: "space-between",
                padding: "0 2px 8px",
                fontSize: "10.5px",
                letterSpacing: ".16em",
                textTransform: "uppercase",
                color: "var(--mute)",
              } satisfies LandingStyle
            }
          >
            <span>target</span>
            <span>status</span>
          </div>
          {deployTargets.map((target, index) => (
            <DeployTargetRow
              key={target.name}
              target={target}
              isLast={index === deployTargets.length - 1}
            />
          ))}
        </div>
        {/* Second column of the deploy section, and a child of this
                container on purpose: anchored to the viewport (`left: 44vw`) it
                drifted across the target table at every width below ~1250px,
                and again above 1180px once the container starts centering.
                `--globe-column` is where the 520px table ends, plus a gutter. */}
        <div
          data-el="globe"
          aria-hidden="true"
          style={
            {
              position: "absolute",
              left: "var(--globe-column)",
              bottom: "-6vw",
              width: "min(58vw, 820px)",
              pointerEvents: "none",
              userSelect: "none",
              willChange: "transform",
            } satisfies LandingStyle
          }
        >
          <img className="globe-art" src="/img/globe.svg" alt="" loading="lazy" />

          <div
            data-gpin=""
            style={
              {
                position: "absolute",
                left: "47.9%",
                top: "28%",
                width: "12px",
                height: "12px",
                opacity: "0",
                transform: "translateY(8px) scale(.94)",
                transition: "opacity 260ms var(--ease-out),transform 300ms var(--ease-out)",
              } satisfies LandingStyle
            }
          >
            <span
              style={
                {
                  position: "absolute",
                  inset: "0",
                  borderRadius: "50%",
                  background: "var(--orange)",
                  boxShadow:
                    "0 0 0 3px rgba(var(--bg-rgb),.7),0 0 0 5px rgba(var(--orange-rgb),.55),0 0 18px var(--orange-glow-hover)",
                } satisfies LandingStyle
              }
            />
            <span
              style={
                {
                  position: "absolute",
                  left: "8px",
                  bottom: "14px",
                  width: "46px",
                  height: "46px",
                  borderRadius: "13px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  boxShadow: "var(--pin-shadow)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                } satisfies LandingStyle
              }
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="#f38020">
                <path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" />
              </svg>
            </span>
          </div>
          <div
            data-gpin=""
            style={
              {
                position: "absolute",
                left: "88.6%",
                top: "40.6%",
                width: "12px",
                height: "12px",
                opacity: "0",
                transform: "translateY(8px) scale(.94)",
                transition:
                  "opacity 260ms var(--ease-out) 40ms,transform 300ms var(--ease-out) 40ms",
              } satisfies LandingStyle
            }
          >
            <span
              style={
                {
                  position: "absolute",
                  inset: "0",
                  borderRadius: "50%",
                  background: "var(--orange)",
                  boxShadow:
                    "0 0 0 3px rgba(var(--bg-rgb),.7),0 0 0 5px rgba(var(--orange-rgb),.55),0 0 18px var(--orange-glow-hover)",
                } satisfies LandingStyle
              }
            />

            <span
              style={
                {
                  position: "absolute",
                  right: "8px",
                  bottom: "14px",
                  width: "46px",
                  height: "46px",
                  borderRadius: "13px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  boxShadow: "var(--pin-shadow)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                } satisfies LandingStyle
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="currentColor"
              >
                <path d="m12 1.608 12 20.784H0Z" />
              </svg>
            </span>
          </div>
          <div
            data-gpin=""
            style={
              {
                position: "absolute",
                left: "72.5%",
                top: "62.6%",
                width: "12px",
                height: "12px",
                opacity: "0",
                transform: "translateY(8px) scale(.94)",
                transition:
                  "opacity 260ms var(--ease-out) 80ms,transform 300ms var(--ease-out) 80ms",
              } satisfies LandingStyle
            }
          >
            <span
              style={
                {
                  position: "absolute",
                  inset: "0",
                  borderRadius: "50%",
                  background: "var(--orange)",
                  boxShadow:
                    "0 0 0 3px rgba(var(--bg-rgb),.7),0 0 0 5px rgba(var(--orange-rgb),.55),0 0 18px var(--orange-glow-hover)",
                } satisfies LandingStyle
              }
            />
            <span
              style={
                {
                  position: "absolute",
                  left: "8px",
                  bottom: "14px",
                  width: "46px",
                  height: "46px",
                  borderRadius: "13px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  boxShadow: "var(--pin-shadow)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                } satisfies LandingStyle
              }
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="23" height="23" fill="#00c7b7">
                <path d="M6.49 19.04h-.23L5.13 17.9v-.23l1.73-1.71h1.2l.15.15v1.2L6.5 19.04ZM5.13 6.31V6.1l1.13-1.13h.23L8.2 6.68v1.2l-.15.15h-1.2L5.13 6.31Zm9.96 9.09h-1.65l-.14-.13v-3.83c0-.68-.27-1.2-1.1-1.23-.42 0-.9 0-1.43.02l-.07.08v4.96l-.14.14H8.9l-.13-.14V8.73l.13-.14h3.7a2.6 2.6 0 0 1 2.61 2.6v4.08l-.13.14Zm-8.37-2.44H.14L0 12.82v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14Zm17.14 0h-6.58l-.14-.14v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14ZM11.05 6.55V1.64l.14-.14h1.65l.14.14v4.9l-.14.14h-1.65l-.14-.13Zm0 15.81v-4.9l.14-.14h1.65l.14.13v4.91l-.14.14h-1.65l-.14-.14Z" />
              </svg>
            </span>
          </div>

          <div
            data-gpin=""
            style={
              {
                position: "absolute",
                left: "78%",
                top: "20%",
                width: "12px",
                height: "12px",
                opacity: "0",
                transform: "translateY(8px) scale(.94)",
                transition:
                  "opacity 260ms var(--ease-out) 120ms,transform 300ms var(--ease-out) 120ms",
              } satisfies LandingStyle
            }
          >
            <span
              style={
                {
                  position: "absolute",
                  inset: "0",
                  borderRadius: "50%",
                  background: "var(--orange)",
                  boxShadow:
                    "0 0 0 3px rgba(var(--bg-rgb),.7),0 0 0 5px rgba(var(--orange-rgb),.55),0 0 18px var(--orange-glow-hover)",
                } satisfies LandingStyle
              }
            />
            <span
              style={
                {
                  position: "absolute",
                  left: "8px",
                  bottom: "14px",
                  width: "46px",
                  height: "46px",
                  borderRadius: "13px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  boxShadow: "var(--pin-shadow)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                } satisfies LandingStyle
              }
            >
              <span
                aria-hidden="true"
                style={
                  {
                    font: "600 22px/1 'JetBrains Mono',monospace",
                    color: "#ff9900",
                  } satisfies LandingStyle
                }
              >
                λ
              </span>
            </span>
          </div>
          <div
            data-gpin=""
            style={
              {
                position: "absolute",
                left: "26%",
                top: "57%",
                width: "12px",
                height: "12px",
                opacity: "0",
                transform: "translateY(8px) scale(.94)",
                transition:
                  "opacity 260ms var(--ease-out) 160ms,transform 300ms var(--ease-out) 160ms",
              } satisfies LandingStyle
            }
          >
            <span
              style={
                {
                  position: "absolute",
                  inset: "0",
                  borderRadius: "50%",
                  background: "var(--orange)",
                  boxShadow:
                    "0 0 0 3px rgba(var(--bg-rgb),.7),0 0 0 5px rgba(var(--orange-rgb),.55),0 0 18px var(--orange-glow-hover)",
                } satisfies LandingStyle
              }
            />
            <span
              style={
                {
                  position: "absolute",
                  left: "8px",
                  bottom: "14px",
                  width: "46px",
                  height: "46px",
                  borderRadius: "13px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  boxShadow: "var(--pin-shadow)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                } satisfies LandingStyle
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="currentColor"
              >
                <path d="M1.105 18.02A11.9 11.9 0 0 1 0 12.985q0-.698.078-1.376a12 12 0 0 1 .231-1.34A12 12 0 0 1 4.025 4.02a12 12 0 0 1 5.46-2.771 12 12 0 0 1 3.428-.23c1.452.112 2.825.477 4.077 1.05a12 12 0 0 1 2.78 1.774 12.02 12.02 0 0 1 4.053 7.078A12 12 0 0 1 24 12.985q0 .454-.036.914a12 12 0 0 1-.728 3.305 12 12 0 0 1-2.38 3.875c-1.33 1.357-3.02 1.962-4.43 1.936a4.4 4.4 0 0 1-2.724-1.024c-.99-.853-1.391-1.83-1.53-2.919a5 5 0 0 1 .128-1.518c.105-.38.37-1.116.76-1.437-.455-.197-1.04-.624-1.226-.829-.045-.05-.04-.13 0-.183a.155.155 0 0 1 .177-.053c.392.134.869.267 1.372.35.66.111 1.484.25 2.317.292 2.03.1 4.153-.813 4.812-2.627s.403-3.609-1.96-4.685-3.454-2.356-5.363-3.128c-1.247-.505-2.636-.205-4.06.582-3.838 2.121-7.277 8.822-5.69 15.032a.191.191 0 0 1-.315.19 12 12 0 0 1-1.25-1.634 12 12 0 0 1-.769-1.404M11.57 6.087c.649-.051 1.214.501 1.31 1.236.13.979-.228 1.99-1.41 2.013-1.01.02-1.315-.997-1.248-1.614.066-.616.574-1.575 1.35-1.635" />
              </svg>
            </span>
          </div>
          <div
            data-gpin=""
            style={
              {
                position: "absolute",
                left: "44%",
                top: "66%",
                width: "12px",
                height: "12px",
                opacity: "0",
                transform: "translateY(8px) scale(.94)",
                transition:
                  "opacity 260ms var(--ease-out) 200ms,transform 300ms var(--ease-out) 200ms",
              } satisfies LandingStyle
            }
          >
            <span
              style={
                {
                  position: "absolute",
                  inset: "0",
                  borderRadius: "50%",
                  background: "var(--orange)",
                  boxShadow:
                    "0 0 0 3px rgba(var(--bg-rgb),.7),0 0 0 5px rgba(var(--orange-rgb),.55),0 0 18px var(--orange-glow-hover)",
                } satisfies LandingStyle
              }
            />
            <span
              style={
                {
                  position: "absolute",
                  left: "8px",
                  bottom: "14px",
                  width: "46px",
                  height: "46px",
                  borderRadius: "13px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  boxShadow: "var(--pin-shadow)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                } satisfies LandingStyle
              }
            >
              <img
                src="/img/brand-nodedotjs.svg"
                alt=""
                aria-hidden="true"
                width="22"
                height="22"
                style={{ display: "block" } satisfies LandingStyle}
              />
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
