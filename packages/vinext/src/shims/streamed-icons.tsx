"use client";

import { useLayoutEffect } from "react";

const STREAMED_ICON_ATTRIBUTE = "data-vinext-streamed-icon";

export function reconcileStreamedIcons(metadataKey: string): void {
  document
    .querySelectorAll<HTMLLinkElement>(`body link[${STREAMED_ICON_ATTRIBUTE}]`)
    .forEach((icon) => document.head.appendChild(icon));

  const ownedIcons = [
    ...document.querySelectorAll<HTMLLinkElement>(`head link[${STREAMED_ICON_ATTRIBUTE}]`),
  ];
  const retainedKeys = new Set<string>();

  for (let index = ownedIcons.length - 1; index >= 0; index--) {
    const icon = ownedIcons[index];
    if (icon.getAttribute(STREAMED_ICON_ATTRIBUTE) !== metadataKey) {
      icon.remove();
      continue;
    }

    const iconKey = `${icon.rel}\n${icon.href}`;
    if (retainedKeys.has(iconKey)) {
      icon.remove();
      continue;
    }
    retainedKeys.add(iconKey);
  }
}

export function StreamedIconsInsertion({ metadataKey }: { metadataKey: string }) {
  useLayoutEffect(() => reconcileStreamedIcons(metadataKey), [metadataKey]);
  return null;
}
