"use client";

import { useEffect } from "react";

export const REINSERT_STREAMED_ICONS_SCRIPT = `document.querySelectorAll('body link[rel="icon"], body link[rel="apple-touch-icon"]').forEach(el => document.head.appendChild(el))`;

export function reinsertStreamedIcons(): void {
  const streamedIcons = document.querySelectorAll(
    'body link[rel="icon"], body link[rel="apple-touch-icon"]',
  );
  if (streamedIcons.length === 0) return;

  document
    .querySelectorAll('head link[rel="icon"], head link[rel="apple-touch-icon"]')
    .forEach((element) => element.remove());
  streamedIcons.forEach((element) => document.head.appendChild(element));
}

export function StreamedIconsInsertion({ metadataKey }: { metadataKey: string }) {
  useEffect(reinsertStreamedIcons, [metadataKey]);
  return <script dangerouslySetInnerHTML={{ __html: REINSERT_STREAMED_ICONS_SCRIPT }} />;
}
