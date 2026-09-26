export const metadata = { title: { default: "Colocated", template: "%s | Colocated" } };

export default function InterceptLayout({ children }: { children: React.ReactNode }) {
  return <div id="intercept-layout-wrapper">{children}</div>;
}
