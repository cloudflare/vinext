import { useRouter } from "next/router";

/** Small fixed badge shown while draft mode is active. */
export const DraftBadge = () => {
  const router = useRouter();

  if (!router.isPreview) {
    return null;
  }

  return (
    <div data-testid="draft-badge">
      Draft mode — <a href="/api/draft?draft=off">leave</a>
    </div>
  );
};
