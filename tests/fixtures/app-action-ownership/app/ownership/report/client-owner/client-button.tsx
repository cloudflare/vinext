"use client";

import { protectedClientAction } from "./actions";

export function ClientButton() {
  return <form action={protectedClientAction} />;
}
