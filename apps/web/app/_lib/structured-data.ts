/**
 * Shared schema.org graph for vinext.dev.
 *
 * The site competes for the "vinext" query against community mirrors that
 * publish richer entity markup than we do. Every node here is stably `@id`'d so
 * the whole site describes one entity rather than three unrelated graphs, and
 * `sameAs` enumerates the corroborating profiles (repo, announcement, npm) that
 * only the official site can legitimately claim.
 */

const SITE_URL = "https://vinext.dev";
const REPO_URL = "https://github.com/cloudflare/vinext";
const ANNOUNCEMENT_URL = "https://blog.cloudflare.com/vinext/";
const CLOUDFLARE_URL = "https://www.cloudflare.com";

const ORGANIZATION_ID = `${SITE_URL}/#organization`;
const SOFTWARE_ID = `${SITE_URL}/#software`;
const WEBSITE_ID = `${SITE_URL}/#website`;

const SITE_NAME = "vinext";
export const SITE_DESCRIPTION =
  "Take any Next.js app and deploy it anywhere with one command. App Router, Pages Router, RSC, ISR — all on Vite.";

type JsonLdNode = Record<string, unknown>;

const organization: JsonLdNode = {
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: "Cloudflare",
  url: CLOUDFLARE_URL,
  sameAs: [
    "https://github.com/cloudflare",
    "https://www.wikidata.org/wiki/Q2748854",
    "https://en.wikipedia.org/wiki/Cloudflare",
  ],
};

const website: JsonLdNode = {
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: SITE_NAME,
  alternateName: "vinext — the official website",
  description: SITE_DESCRIPTION,
  url: `${SITE_URL}/`,
  inLanguage: "en",
  publisher: { "@id": ORGANIZATION_ID },
  about: { "@id": SOFTWARE_ID },
};

const software: JsonLdNode = {
  "@type": "SoftwareApplication",
  "@id": SOFTWARE_ID,
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: `${SITE_URL}/`,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  isAccessibleForFree: true,
  license: `${REPO_URL}/blob/main/LICENSE`,
  author: { "@id": ORGANIZATION_ID },
  creator: { "@id": ORGANIZATION_ID },
  publisher: { "@id": ORGANIZATION_ID },
  sameAs: [REPO_URL, ANNOUNCEMENT_URL, "https://www.npmjs.com/package/vinext"],
};

const sourceCode: JsonLdNode = {
  "@type": "SoftwareSourceCode",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: `${SITE_URL}/`,
  codeRepository: REPO_URL,
  programmingLanguage: "TypeScript",
  license: `${REPO_URL}/blob/main/LICENSE`,
  author: { "@id": ORGANIZATION_ID },
  isPartOf: { "@id": SOFTWARE_ID },
};

/** Rendered once per page from the root layout. */
export const siteGraph = {
  "@context": "https://schema.org",
  "@graph": [organization, website, software, sourceCode],
};

/**
 * Breadcrumbs for a second-level page. The home crumb is always first so every
 * subpage restates vinext.dev as the root of the entity.
 */
export function breadcrumbGraph(name: string, path: string) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        "@id": `${SITE_URL}${path}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
          { "@type": "ListItem", position: 2, name, item: `${SITE_URL}${path}` },
        ],
      },
    ],
  };
}
