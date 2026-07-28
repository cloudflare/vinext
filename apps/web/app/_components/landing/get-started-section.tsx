import type { LandingStyle } from "./landing-styles";
import { CopyButton } from "./copy-button";

/* Mirrors the flow the repo itself recommends (README quick start and the
   bundled migrate-to-vinext Agent Skill), so the prompt never promises
   behavior the tooling does not have. Update it alongside those docs. */
const agentPrompt = `Please migrate this Next.js app to vinext (Next.js on Vite: vinext.dev). Install the official Agent Skill with npx skills add cloudflare/vinext and follow it. If the skills CLI is unavailable, use the vinext CLI directly (npx vinext check, then npx vinext init) and follow its output, consulting the vinext.dev docs or searching the web as needed. Verify the app builds, runs, and passes tests under vinext.`;

export function GetStartedSection() {
  return (
    <section
      id="start"
      data-screen-label="Get started"
      style={{ position: "relative", zIndex: "2", padding: "96px 0 120px" } satisfies LandingStyle}
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
            } satisfies LandingStyle
          }
        >
          Migrate in one command.
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
            npx vinext init
          </code>
          . It installs vinext, writes your Vite config, and adds the scripts. Your{" "}
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
            next.config.js
          </code>{" "}
          is read as-is.
        </p>

        <div
          data-rv=""
          style={
            {
              opacity: "0",
              transform: "translateY(24px)",
              transition: "opacity var(--t),transform var(--t)",
              transitionDelay: ".16s",
              marginTop: "32px",
              display: "flex",
              alignItems: "center",
              gap: "16px",
              maxWidth: "460px",
              padding: "16px",
              border: "1px solid var(--line)",
              borderRadius: "12px",
              background: "var(--surface)",
            } satisfies LandingStyle
          }
        >
          <span
            style={
              {
                flex: "none",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: "14px",
                color: "var(--mute)",
              } satisfies LandingStyle
            }
          >
            $
          </span>
          <code
            style={
              {
                flex: "1",
                minWidth: "0",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: "14px",
                letterSpacing: "-.01em",
                color: "var(--ink)",
                overflowX: "auto",
              } satisfies LandingStyle
            }
          >
            npx vinext init
          </code>
          <CopyButton value="npx vinext init" ariaLabel="Copy command" />
        </div>

        {/* Agent path, as a twin of the command box above: same shell, but
            the sigil is a sparkle and the payload is the migration prompt.
            The parallel structure is what explains it — command for you,
            prompt for your agent — so the full text never has to render.
            Truncation is fine: the copy payload is the data-copy attribute. */}
        <div
          data-rv=""
          style={
            {
              opacity: "0",
              transform: "translateY(24px)",
              transition: "opacity var(--t),transform var(--t)",
              transitionDelay: ".18s",
              margin: "12px 0 0 16px",
              maxWidth: "460px",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: "11px",
              color: "var(--mute)",
            } satisfies LandingStyle
          }
        >
          or
        </div>

        <div
          data-rv=""
          style={
            {
              opacity: "0",
              transform: "translateY(24px)",
              transition: "opacity var(--t),transform var(--t)",
              transitionDelay: ".2s",
              marginTop: "12px",
              display: "flex",
              alignItems: "center",
              gap: "16px",
              maxWidth: "460px",
              padding: "16px",
              border: "1px solid var(--line)",
              borderRadius: "12px",
              background: "var(--surface)",
            } satisfies LandingStyle
          }
        >
          <span
            aria-hidden="true"
            style={
              {
                flex: "none",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: "14px",
                color: "var(--orange-soft)",
              } satisfies LandingStyle
            }
          >
            ✦
          </span>
          <span
            style={
              {
                flex: "1",
                minWidth: "0",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: "14px",
                letterSpacing: "-.01em",
                color: "var(--ink)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              } satisfies LandingStyle
            }
          >
            prompt for your coding agent
          </span>
          <CopyButton value={agentPrompt} ariaLabel="Copy migration prompt for your coding agent" />
        </div>

        <div
          data-rv=""
          style={
            {
              opacity: "0",
              transform: "translateY(24px)",
              transition: "opacity var(--t),transform var(--t)",
              marginTop: "32px",
              maxWidth: "460px",
            } satisfies LandingStyle
          }
        >
          <p
            style={
              {
                margin: "0",
                fontSize: "16.5px",
                lineHeight: "1.65",
                color: "var(--ink-sub)",
              } satisfies LandingStyle
            }
          >
            Try it on a branch. If something breaks, open an issue.
          </p>
          <a
            className="text-link"
            href="https://github.com/cloudflare/vinext#quick-start"
            style={
              {
                display: "inline-block",
                marginTop: "16px",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: "13px",
                textDecoration: "none",
              } satisfies LandingStyle
            }
          >
            Quick start
          </a>
        </div>
      </div>
    </section>
  );
}
