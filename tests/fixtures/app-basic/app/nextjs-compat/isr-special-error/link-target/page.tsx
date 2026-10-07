import { notFound } from "next/navigation";

// An ISR page whose notFound() rejects the shell, navigated to by the links
// in ../link/[mode].
export const revalidate = 60;

export default function Page() {
  notFound();
}
