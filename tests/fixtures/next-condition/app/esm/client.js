"use client";

import { named as exportsNamed } from "my-esm-package/exports";
import { named as importsNamed } from "my-esm-package/imports";

export default function Client() {
  return <p id="client">{[exportsNamed, importsNamed].join(" | ")}</p>;
}
