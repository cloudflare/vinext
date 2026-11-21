import { headers } from "next/headers";
import { Header } from "./header";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  if (requestHeaders.get("x-vinext-throw-root-layout") === "1") {
    throw new Error("root layout failed");
  }

  return (
    <html>
      <body>
        <nav id="root-layout">Root Layout</nav>
        <Header />
        {children}
      </body>
    </html>
  );
}
