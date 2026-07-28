const footerLink = "footer-link text-[var(--sub)] no-underline transition-colors duration-200";

export function SiteFooter() {
  return (
    <footer className="relative z-2 mt-auto border-t border-[var(--line-soft)] px-0 pt-8 pb-16 font-mono text-xs text-[var(--mute)]">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-4 px-8">
        <span>MIT License</span>
        <span className="flex gap-6">
          <a className={footerLink} href="https://blog.cloudflare.com/vinext/">
            Blog
          </a>
          {/* Server invite, not a channel deep link — discord.com/channels/…
              URLs only resolve for users already in the server. */}
          <a className={footerLink} href="https://discord.cloudflare.com/">
            Discord
          </a>
          <a className={footerLink} href="https://www.npmjs.com/package/vinext">
            npm
          </a>
        </span>
      </div>
    </footer>
  );
}
