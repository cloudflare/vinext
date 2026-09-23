import type { ReactNode } from "react";

export const dynamic = "error";
export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default function Layout({ sidebar }: { sidebar: ReactNode }) {
  return <main>{sidebar}</main>;
}
