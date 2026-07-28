import { formatUtcDateTime } from "../../benchmarks/components/format";
import { getRaceFrame } from "../../lib/landing-race";
import { compareBuild, compareBundle, formatKb, type LandingStats } from "../../lib/landing-stats";
import { provenanceStyle, type LandingStyle } from "./landing-styles";

const doneBadgeStyle = {
  transition: "opacity .3s",
  fontSize: "11px",
  color: "var(--ok)",
  border: "1px solid rgba(70,211,154,.3)",
  borderRadius: "999px",
  padding: "2px 8px",
} satisfies LandingStyle;

export function BenchmarkSection({ stats }: { stats: LandingStats }) {
  const build = compareBuild(stats.buildSeconds);
  const bundle = compareBundle(stats.bundleBytes);
  const source = stats.provenance.benchmark;
  const isLive = source.source === "live";
  const finalRace = getRaceFrame(stats.buildSeconds, 1);
  const vinextWins = stats.buildSeconds.vinext < stats.buildSeconds.nextjs;
  const nextjsWins = stats.buildSeconds.nextjs < stats.buildSeconds.vinext;
  const buildHeadline = !isLive
    ? "Built for speed."
    : build.verdict === "better"
      ? `${build.multiple} faster in our 33-route benchmark.`
      : build.verdict === "worse"
        ? `${build.multiple} slower in our 33-route benchmark.`
        : "Build time on par in our 33-route benchmark.";
  const buildStatCaption = isLive
    ? build.verdict === "better"
      ? "faster benchmark build"
      : build.verdict === "worse"
        ? "slower benchmark build"
        : "benchmark build parity"
    : "reference build snapshot";
  const bundleStatCaption = isLive
    ? bundle.verdict === "better"
      ? "smaller client bundle in the same benchmark"
      : bundle.verdict === "worse"
        ? "larger client bundle in the same benchmark"
        : "client bundle size on par in the same benchmark"
    : "reference client bundle snapshot";
  const benchmarkProvenance = isLive
    ? `33-route dynamic-render benchmark · commit ${source.commitSha?.slice(0, 7) ?? "unknown"} · ${formatUtcDateTime(source.measuredAt)}`
    : "33-route dynamic-render benchmark · reference snapshot · live benchmark data unavailable";

  return (
    <section
      id="speed"
      data-el="raceOuter"
      data-screen-label="Speed / benchmark race"
      style={{ position: "relative", zIndex: "2", padding: "96px 0" } satisfies LandingStyle}
    >
      <div
        id="benchLayout"
        style={
          {
            maxWidth: "1180px",
            margin: "0 auto",
            padding: "0 32px",
            display: "grid",
            gridTemplateColumns: "minmax(0,0.92fr) minmax(0,1.08fr)",
            gap: "clamp(40px,6vw,88px)",
            alignItems: "start",
          } satisfies LandingStyle
        }
      >
        {/* Left rail: the section's claim. Split from the bars on the right so
            this stops repeating the stacked headline-over-full-width-widget
            shape every other section uses, and the bars stay short enough that
            the speed gap reads at a glance instead of spanning 1180px. */}
        <div>
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
            <span style={{ color: "var(--orange)" } satisfies LandingStyle}>{buildHeadline}</span>
          </h2>{" "}
          <p data-rv="" style={provenanceStyle}>
            {benchmarkProvenance}
          </p>
        </div>

        {/* Right column: the race itself — the evidence for the claim. */}
        <div>
          <div
            style={
              {
                display: "flex",
                flexDirection: "column",
                gap: "24px",
              } satisfies LandingStyle
            }
          >
            <div>
              <div
                style={
                  {
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    marginBottom: "8px",
                  } satisfies LandingStyle
                }
              >
                <span
                  style={
                    {
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: "14px",
                      color: "var(--ink)",
                    } satisfies LandingStyle
                  }
                >
                  vinext
                  <span
                    data-el="vinextDone"
                    style={
                      {
                        ...doneBadgeStyle,
                        opacity: finalRace.vinextDone && vinextWins ? "1" : "0",
                      } satisfies LandingStyle
                    }
                  >
                    ✓ done
                  </span>
                </span>
                <span
                  data-el="vinextTime"
                  style={
                    {
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: "22px",
                      fontWeight: "600",
                      color: "var(--orange)",
                      fontVariantNumeric: "tabular-nums",
                    } satisfies LandingStyle
                  }
                >
                  {finalRace.vinextTime.toFixed(1)}s
                </span>
              </div>
              <div
                style={
                  {
                    position: "relative",
                    height: "16px",
                    borderRadius: "999px",
                    background: "rgba(var(--ink-rgb),.05)",
                    overflow: "hidden",
                  } satisfies LandingStyle
                }
              >
                <div
                  data-el="vinextFill"
                  style={
                    {
                      position: "absolute",
                      top: "0",
                      left: "0",
                      bottom: "0",
                      width: "100%",
                      transform: `scaleX(${finalRace.vinextFill.toFixed(4)})`,
                      background: "linear-gradient(90deg,var(--orange),var(--amber))",
                      borderRadius: "999px",
                      boxShadow: "0 0 20px rgba(var(--orange-rgb),.4)",
                    } satisfies LandingStyle
                  }
                />
              </div>
            </div>
            <div>
              <div
                style={
                  {
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    marginBottom: "8px",
                  } satisfies LandingStyle
                }
              >
                <span
                  style={
                    {
                      display: nextjsWins ? "flex" : undefined,
                      alignItems: nextjsWins ? "center" : undefined,
                      gap: nextjsWins ? "8px" : undefined,
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: "14px",
                      color: "var(--sub)",
                    } satisfies LandingStyle
                  }
                >
                  Next.js 16 · turbopack
                  <span
                    data-el="nextjsDone"
                    style={
                      {
                        ...doneBadgeStyle,
                        display: nextjsWins ? "inline-flex" : "none",
                        opacity: finalRace.nextjsDone && nextjsWins ? "1" : "0",
                      } satisfies LandingStyle
                    }
                  >
                    ✓ done
                  </span>
                </span>
                <span
                  data-el="nextTime"
                  style={
                    {
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: "22px",
                      fontWeight: "600",
                      color: "var(--mute)",
                      fontVariantNumeric: "tabular-nums",
                    } satisfies LandingStyle
                  }
                >
                  {finalRace.nextjsTime.toFixed(1)}s
                </span>
              </div>
              <div
                style={
                  {
                    position: "relative",
                    height: "16px",
                    borderRadius: "999px",
                    background: "rgba(var(--ink-rgb),.05)",
                    overflow: "hidden",
                  } satisfies LandingStyle
                }
              >
                <div
                  data-el="nextFill"
                  style={
                    {
                      position: "absolute",
                      top: "0",
                      left: "0",
                      bottom: "0",
                      width: "100%",
                      transform: `scaleX(${finalRace.nextjsFill.toFixed(4)})`,
                      background: "linear-gradient(90deg,var(--next-bar-1),var(--next-bar-2))",
                      borderRadius: "999px",
                    } satisfies LandingStyle
                  }
                />
              </div>
            </div>
          </div>

          <div
            data-el="payoff"
            style={
              {
                opacity: "1",
                transform: "none",
                transition: "opacity 280ms var(--ease-out),transform 280ms var(--ease-out)",
                marginTop: "32px",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "16px 40px",
              } satisfies LandingStyle
            }
          >
            <div
              style={{ display: "flex", alignItems: "center", gap: "16px" } satisfies LandingStyle}
            >
              <span
                style={
                  {
                    fontFamily: "'Geist',system-ui,sans-serif",
                    fontWeight: "700",
                    fontSize: "clamp(48px,7vw,84px)",
                    lineHeight: "1",
                    letterSpacing: "-.03em",
                    color: "var(--orange)",
                    textShadow: "0 0 40px rgba(var(--orange-rgb),.3)",
                  } satisfies LandingStyle
                }
              >
                {build.multiple}
              </span>
              <span
                style={
                  {
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: "13px",
                    color: "var(--sub)",
                    maxWidth: "16ch",
                    lineHeight: "1.4",
                  } satisfies LandingStyle
                }
              >
                {buildStatCaption}
              </span>
            </div>
            <div
              style={{ display: "flex", alignItems: "center", gap: "16px" } satisfies LandingStyle}
            >
              <span
                style={
                  {
                    fontFamily: "'Geist',system-ui,sans-serif",
                    fontWeight: "700",
                    fontSize: "clamp(48px,7vw,84px)",
                    lineHeight: "1",
                    letterSpacing: "-.03em",
                    color: "var(--ink)",
                  } satisfies LandingStyle
                }
              >
                {bundle.pct}%
              </span>
              <span
                style={
                  {
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: "13px",
                    color: "var(--sub)",
                    maxWidth: "20ch",
                    lineHeight: "1.4",
                  } satisfies LandingStyle
                }
              >
                {bundleStatCaption} · {formatKb(stats.bundleBytes.nextjs)} →{"\u00a0"}
                {formatKb(stats.bundleBytes.vinext)} gzipped
              </span>
            </div>
            <a
              className="text-link"
              href="/benchmarks"
              style={
                {
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: "12px",
                  textDecoration: "none",
                } satisfies LandingStyle
              }
            >
              see live benchmarks
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
