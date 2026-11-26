import { unauthorized } from "next/navigation";

export default function UnauthPage() {
  unauthorized();
}
