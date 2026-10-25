/**
 * Test fixture: page that calls notFound(). The nearest not-found file is
 * [lang]/not-found.tsx, in a segment without a layout, so its boundary
 * replaces the shop layout.
 */
import { notFound } from "next/navigation";

export default function Page(): never {
  notFound();
}
