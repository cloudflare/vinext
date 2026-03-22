export const metadata = {
  title: "Prisma + Hyperdrive on vinext",
  description: "Full-stack example with Prisma, Hyperdrive, and Cloudflare Workers",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 600, margin: "40px auto", padding: "0 16px" }}>
        {children}
      </body>
    </html>
  );
}
