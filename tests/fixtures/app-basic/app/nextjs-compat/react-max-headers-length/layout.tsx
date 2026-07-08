import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({
  variable: "--font-react-max-headers-length-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-react-max-headers-length-mono",
  subsets: ["latin"],
});

export default function ReactMaxHeadersLengthLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${geistSans.variable} ${geistMono.variable}`}>{children}</div>;
}
