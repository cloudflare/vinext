import { forbidden } from "next/navigation";

// No loading.tsx beside it, so a hard load gets a 403 document.
export default function DeniedNotePage() {
  forbidden();
}
