import { formatUtcDateTime } from "../../benchmarks/components/format";
import type { LandingStats } from "../../lib/landing-stats";
import { provenanceStyle, type LandingStyle } from "./landing-styles";

type CompatibilityStatus = "Supported" | "Experimental";
type CompatibilityRow = { label: string; subtitle?: string; status: CompatibilityStatus };
type CompatibilityGroup = { title: string; rows: readonly CompatibilityRow[] };

const compatibilityGroups = [
  {
    title: "Core routing & components",
    rows: [
      {
        label: "App Router",
        subtitle: "layouts · server components · streaming",
        status: "Supported",
      },
      { label: "Pages Router", subtitle: "getServerSideProps · API routes", status: "Supported" },
      { label: "React Server Components", status: "Supported" },
      { label: "Server Actions", status: "Supported" },
      { label: "next/font", subtitle: "local & Google fonts", status: "Supported" },
    ],
  },
  {
    title: "Advanced tooling & optimization",
    rows: [
      { label: "Middleware", subtitle: "rewrites · headers · redirects", status: "Supported" },
      { label: "ISR / revalidate", status: "Supported" },
      { label: "Parallel & intercepting routes", status: "Supported" },
      { label: "Image optimization", subtitle: "Cloudflare Images", status: "Supported" },
      {
        label: "Traffic-aware Pre-Rendering",
        subtitle: "zone analytics at deploy time",
        status: "Experimental",
      },
    ],
  },
] satisfies readonly CompatibilityGroup[];

function StatusLabel({ status }: { status: CompatibilityStatus }) {
  const supported = status === "Supported";
  return (
    <span
      style={
        {
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: "12px",
          color: supported ? "var(--ok)" : "var(--partial)",
          whiteSpace: "nowrap",
        } satisfies LandingStyle
      }
    >
      <span
        style={
          {
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: supported ? "var(--ok)" : undefined,
            border: supported ? undefined : "1.4px solid var(--partial)",
          } satisfies LandingStyle
        }
      />
      {status}
    </span>
  );
}

function CompatibilityRow({ row, isLast }: { row: CompatibilityRow; isLast: boolean }) {
  return (
    <div
      style={
        {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          padding: "16px 24px",
          borderBottom: isLast ? undefined : "1px solid var(--line-soft)",
        } satisfies LandingStyle
      }
    >
      <span style={{ fontSize: "15px", color: "var(--ink)" } satisfies LandingStyle}>
        {row.label}
        {row.subtitle ? (
          <small
            style={
              {
                display: "block",
                color: "var(--mute)",
                fontSize: "11.5px",
                marginTop: "4px",
                fontFamily: "'JetBrains Mono',monospace",
              } satisfies LandingStyle
            }
          >
            {row.subtitle}
          </small>
        ) : null}
      </span>
      <StatusLabel status={row.status} />
    </div>
  );
}

function CompatibilityGroupCard({ group, index }: { group: CompatibilityGroup; index: number }) {
  return (
    <div
      data-rv=""
      style={
        {
          opacity: "0",
          transform: "translateY(24px)",
          transition: "opacity var(--t),transform var(--t)",
          transitionDelay: index === 0 ? undefined : ".08s",
          padding: "5px",
          border: "1px solid var(--line-soft)",
          borderRadius: "20px",
          background: "rgba(var(--ink-rgb),.02)",
        } satisfies LandingStyle
      }
    >
      <div
        style={
          {
            border: "1px solid var(--line)",
            borderRadius: "15px",
            background: "var(--surface)",
            boxShadow: "inset 0 1px 0 rgba(var(--ink-rgb),.05)",
            overflow: "hidden",
          } satisfies LandingStyle
        }
      >
        <div
          style={
            {
              padding: "16px 24px",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: "11px",
              color: "var(--mute)",
              letterSpacing: ".06em",
              textTransform: "uppercase",
              borderBottom: "1px solid var(--line-soft)",
            } satisfies LandingStyle
          }
        >
          {group.title}
        </div>
        {group.rows.map((row, rowIndex) => (
          <CompatibilityRow key={row.label} row={row} isLast={rowIndex === group.rows.length - 1} />
        ))}
      </div>
    </div>
  );
}

export function CompatibilitySection({ stats }: { stats: LandingStats }) {
  const source = stats.provenance.compatibility;
  const compatibilityProvenance =
    source.source === "live"
      ? `Latest deploy-suite run${source.commitSha ? ` · commit ${source.commitSha.slice(0, 7)}` : ""} · ${formatUtcDateTime(source.measuredAt)}`
      : "Reference snapshot · live deploy-suite data unavailable";

  return (
    <section
      id="compat"
      data-screen-label="Compatibility"
      style={{ position: "relative", zIndex: "2", padding: "96px 0" } satisfies LandingStyle}
    >
      <div
        style={{ maxWidth: "1180px", margin: "0 auto", padding: "0 32px" } satisfies LandingStyle}
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
              maxWidth: "20ch",
            } satisfies LandingStyle
          }
        >
          {stats.compatPassRate}% deploy-suite test pass rate
        </h2>
        <p data-rv="" style={provenanceStyle}>
          {compatibilityProvenance}
        </p>
        <div
          id="compatGrid"
          style={
            {
              marginTop: "40px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "24px",
            } satisfies LandingStyle
          }
        >
          {compatibilityGroups.map((group, index) => (
            <CompatibilityGroupCard key={group.title} group={group} index={index} />
          ))}
        </div>
        <a
          className="text-link"
          href="/compatibility"
          style={
            {
              display: "inline-block",
              marginTop: "48px",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: "12px",
              textDecoration: "none",
            } satisfies LandingStyle
          }
        >
          full compatibility report
        </a>
      </div>
    </section>
  );
}
