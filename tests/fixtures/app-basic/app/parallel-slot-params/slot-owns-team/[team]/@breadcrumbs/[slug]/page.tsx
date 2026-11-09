export { TeamBreadcrumb as default } from "../../../../components";

export function generateStaticParams() {
  return [{ team: "acme", slug: "public" }];
}
