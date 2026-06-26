import { TemplateIdentity } from "./template-identity";

export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <>
      <h1>Server template</h1>
      <TemplateIdentity testId="server-template-identity" />
      {children}
    </>
  );
}
