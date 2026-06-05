import { LayoutHmrToggle } from "./layout-hmr-toggle";

export default function DevOverlayLayoutHmrToggleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <section>
      <LayoutHmrToggle />
      {children}
    </section>
  );
}
