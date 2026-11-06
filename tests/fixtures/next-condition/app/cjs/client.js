"use client";

import { named as exportsNamed } from "my-cjs-package/exports";
import { named as importsNamed } from "my-cjs-package/imports";

export default function Client() {
  return <p id="client">{[exportsNamed, importsNamed].join(" | ")}</p>;
}
