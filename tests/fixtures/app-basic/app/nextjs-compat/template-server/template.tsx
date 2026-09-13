import { TemplateIdentity } from "./template-identity";

export default function Template({ children }: { children: React.ReactNode }) {
  const renderId = crypto.randomUUID();

  return (
    <>
      <h1>Server template</h1>
      <span data-testid="server-template-render-id">{renderId}</span>
      <TemplateIdentity testId="server-template-identity" />
      {children}
    </>
  );
}
