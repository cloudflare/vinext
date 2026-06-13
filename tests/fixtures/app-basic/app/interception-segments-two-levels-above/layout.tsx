export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <div id="children">{children}</div>
      </body>
    </html>
  );
}
