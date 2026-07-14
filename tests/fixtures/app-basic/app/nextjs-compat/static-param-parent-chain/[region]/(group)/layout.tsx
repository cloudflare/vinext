export const dynamicParams = false;

export function generateStaticParams({ params }: { params: { region?: string } }) {
  return params.region === "EU" ? [{ lang: "En" }] : [];
}

export default function StaticParamParentGroupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
