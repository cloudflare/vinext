import { unauthorized } from "next/navigation";

export default function UnauthorizedTestPage() {
  // This page always triggers a 401
  unauthorized();
}
