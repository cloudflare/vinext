import { notFound } from "next/navigation";

export default function NotFoundTestPage() {
  // This page always triggers a 404
  notFound();
}
