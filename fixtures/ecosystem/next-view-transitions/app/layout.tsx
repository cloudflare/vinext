import { ViewTransitions } from "next-view-transitions";

export const metadata = {
  title: "next-view-transitions test",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ViewTransitions>
      <html lang="en">
        <body>
          <nav>
            <a href="/">Home</a>
            <a href="/about">About</a>
          </nav>
          {children}
        </body>
      </html>
    </ViewTransitions>
  );
}
