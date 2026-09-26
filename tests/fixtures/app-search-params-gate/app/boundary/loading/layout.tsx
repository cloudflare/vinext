import { RenderId } from "../../fixture-parts";

// loading.tsx wraps the whole page, so the render marker sits in the layout.
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <RenderId />
      {children}
    </>
  );
}
