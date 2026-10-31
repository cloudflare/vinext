import { headers } from "next/headers";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  if ((await headers()).has("x-throw-root-layout")) {
    throw new Error("root layout failed");
  }
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
