import s from "./styles.module.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  console.log(s);

  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
