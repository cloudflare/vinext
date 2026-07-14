export const dynamicParams = false;

export function generateStaticParams() {
  return [{ region: "SE" }, { region: "DE" }];
}

export default function StaticParamCaseForceDynamicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
