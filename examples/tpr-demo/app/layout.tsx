import "./globals.css";

export const metadata = {
  title: "TPR Demo — Traffic-aware Pre-Warming",
  description:
    "A demo of vinext's TPR feature: pre-warm only the routes that matter.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
