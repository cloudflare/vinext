import { redirect } from "next/navigation";

// "/.//other.invalid/landing" is a path on this origin whose pathname is
// "//other.invalid/landing".
export default function LayoutRedirect(): never {
  redirect("/.//other.invalid/landing");
}
