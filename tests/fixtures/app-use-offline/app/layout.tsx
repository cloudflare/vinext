import { OfflineStatus } from "../components/offline-status";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OfflineStatus />
        {children}
      </body>
    </html>
  );
}
