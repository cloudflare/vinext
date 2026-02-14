import { permanentRedirect } from "next/navigation";

// permanentRedirect() returns a 308 status code
export default function PermanentRedirectTestPage() {
  permanentRedirect("/about");
}
