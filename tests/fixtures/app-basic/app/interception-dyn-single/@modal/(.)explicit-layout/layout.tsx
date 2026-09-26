export const metadata = {
  title: { default: "Ancestor", template: "%s | Ancestor" },
};

export default function InterceptAncestorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
