import { NuqsAdapter } from "nuqs/adapters/next/app";

export const metadata = {
  title: "nuqs test",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  );
}
