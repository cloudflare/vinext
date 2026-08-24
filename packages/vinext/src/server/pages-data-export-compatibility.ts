import { hasPagesGetInitialProps } from "./pages-get-initial-props.js";

const SSG_GET_INITIAL_PROPS_CONFLICT =
  "You can not use getInitialProps with getStaticProps. To use SSG, please remove your getInitialProps";

export type PagesDataExportModule = {
  default?: unknown;
  getStaticProps?: unknown;
};

export class PagesDataExportCompatibilityError extends Error {
  override name = "PagesDataExportCompatibilityError";
}

/** Reject Pages data-export combinations that Next.js does not allow. */
export function assertPagesDataExportCompatibility(
  pageModule: PagesDataExportModule,
  routePattern: string,
): void {
  if (
    typeof pageModule.getStaticProps === "function" &&
    hasPagesGetInitialProps(pageModule.default)
  ) {
    throw new PagesDataExportCompatibilityError(
      `${SSG_GET_INITIAL_PROPS_CONFLICT} ${routePattern}`,
    );
  }
}
