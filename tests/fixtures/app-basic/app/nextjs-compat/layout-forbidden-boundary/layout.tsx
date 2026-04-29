import { forbidden } from "next/navigation";

/**
 * Next.js compat: forbidden/basic — access fallback thrown from a layout should
 * render the matching forbidden boundary, not the not-found boundary.
 */
export default function Layout() {
  forbidden();
}
