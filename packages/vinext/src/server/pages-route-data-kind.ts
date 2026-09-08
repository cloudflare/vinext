export type RuntimePagesDataKind = "initial" | "none" | "server" | "static";

/** Build-time classification available before a Pages module is loaded. */
export type PagesRouteDataKind = Exclude<RuntimePagesDataKind, "initial">;

type PagesModule = {
  default?: { getInitialProps?: unknown };
  getServerSideProps?: unknown;
  getStaticProps?: unknown;
};

type AppComponent = {
  getInitialProps?: unknown;
  origGetInitialProps?: unknown;
} | null;

/** Classify loaded Pages modules after HOCs and re-exports have been evaluated. */
export function getRuntimePagesDataKind(
  pageModule: PagesModule,
  appComponent: AppComponent,
): RuntimePagesDataKind {
  if (typeof pageModule.getStaticProps === "function") return "static";
  if (typeof pageModule.getServerSideProps === "function") return "server";
  if (typeof pageModule.default?.getInitialProps === "function") return "initial";
  if (
    typeof appComponent?.getInitialProps === "function" &&
    appComponent.getInitialProps !== appComponent.origGetInitialProps
  ) {
    return "initial";
  }
  return "none";
}
