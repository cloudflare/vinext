"use client";

import { named as exportsNamed } from "my-external-cjs-package/exports";
import { named as importsNamed } from "my-external-cjs-package/imports";

export default function Client() {
  return <p id="client">{[exportsNamed, importsNamed].join(" | ")}</p>;
}
