import ConsentBanner from "./consent-banner";

// Cookie-notice blockers filter URLs by names such as `/consent-banner-`, so a
// client component's source name must not reach its public chunk URL.
export default function CookieNoticeChunksLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ConsentBanner />
      {children}
    </>
  );
}
