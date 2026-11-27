import { VtBoundary } from "../vt-boundary";
import { AppTransitionButton } from "./app-transition-button";

export default function ViewTransitionTypesSearchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <VtBoundary name="search-layout">
        <AppTransitionButton />
      </VtBoundary>
      {children}
    </>
  );
}
