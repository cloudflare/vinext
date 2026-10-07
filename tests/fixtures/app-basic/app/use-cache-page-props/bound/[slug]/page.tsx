// A bound "use cache" page component and generateMetadata are still cache
// functions in Next.js (`isUseCacheFunction` reads the server reference id), so
// they receive `$$isPage` and stay prerenderable.
import CachedPage, { generateMetadata as cachedGenerateMetadata } from "./cached-page";

export const generateMetadata = cachedGenerateMetadata.bind(null);

export default CachedPage.bind(null);

export function generateStaticParams() {
  return [{ slug: "prerendered" }];
}
