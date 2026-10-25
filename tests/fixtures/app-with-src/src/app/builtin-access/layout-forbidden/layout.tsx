import { forbidden } from "next/navigation";

export default function ForbiddenLayout(_props: { children: React.ReactNode }) {
  forbidden();
}
