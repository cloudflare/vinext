/**
 * Root template — wraps all pages but re-mounts on navigation.
 * Unlike layout.tsx, template.tsx creates a new instance for each route.
 */
export default function RootTemplate({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="root-template">
      <div className="template-header">Template Active</div>
      {children}
    </div>
  );
}
