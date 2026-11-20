// Used by E2E: app-router/interception-rewritten-source.spec.ts
export default function GatedMembersLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div data-testid="gated-members-layout">
      {children}
      {modal}
    </div>
  );
}
