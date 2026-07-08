import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  if (requestHeaders.get("x-vinext-root-layout-redirect") === "1") {
    redirect("/result");
  }

  return (
    <html>
      <body>
        <nav id="layout-nav">Navbar</nav>
        {children}
      </body>
    </html>
  );
}
