"use client";

import { forbidden } from "next/navigation";

export default function ClientForbiddenPage() {
  forbidden();
}
