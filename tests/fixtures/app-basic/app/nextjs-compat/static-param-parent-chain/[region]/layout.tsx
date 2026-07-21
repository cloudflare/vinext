export const dynamicParams = false;

export function generateStaticParams() {
  return [{ region: "EU" }];
}

export default function StaticParamParentRegionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
