"use client";

import { named } from "my-barrel-package";

export default function Client() {
  return <p id="client">{named}</p>;
}
