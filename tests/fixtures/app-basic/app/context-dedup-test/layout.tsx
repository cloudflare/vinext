import { ThemeProvider } from "fake-context-lib";

export default function ContextDedupLayout({ children }: { children: React.ReactNode }) {
  return <ThemeProvider theme="dark-test-theme">{children}</ThemeProvider>;
}
