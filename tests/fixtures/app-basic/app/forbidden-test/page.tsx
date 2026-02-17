import { forbidden } from "next/navigation";

export default function ForbiddenTestPage() {
  // This page always triggers a 403
  forbidden();
}
