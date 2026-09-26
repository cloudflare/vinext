export const metadata = {
  title: { default: "Colocated", template: "%s | Colocated" },
};

export default function InterceptPageLayout({ children }: { children: React.ReactNode }) {
  return children;
}
