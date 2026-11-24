import { forbidden } from "next/navigation";

export default function DeniedPage() {
  forbidden();
}
