export default function DynamicInterceptionRevalidateLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div>
      {children}
      {modal}
    </div>
  );
}

export const revalidate = 0;

export function generateStaticParams() {
  return [{ locale: "en" }];
}
