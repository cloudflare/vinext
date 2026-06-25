"use client";

import { useLayoutEffect } from "react";

const STREAMED_ICON_ATTRIBUTE = "data-vinext-streamed-icon";

function getStreamedIconOrder(icon: HTMLLinkElement, metadataKey: string): number | null {
  const marker = icon.getAttribute(STREAMED_ICON_ATTRIBUTE);
  const prefix = `${metadataKey}:`;
  if (!marker?.startsWith(prefix)) {
    return null;
  }

  const order = Number(marker.slice(prefix.length));
  return Number.isInteger(order) && order >= 0 ? order : null;
}

export function reconcileStreamedIcons(metadataKey: string): void {
  document
    .querySelectorAll<HTMLLinkElement>(`body link[${STREAMED_ICON_ATTRIBUTE}]`)
    .forEach((icon) => document.head.appendChild(icon));

  const ownedIcons = [
    ...document.querySelectorAll<HTMLLinkElement>(`head link[${STREAMED_ICON_ATTRIBUTE}]`),
  ];
  const retainedIcons = new Map<number, HTMLLinkElement>();

  for (const icon of ownedIcons) {
    const order = getStreamedIconOrder(icon, metadataKey);
    if (order === null) {
      icon.remove();
      continue;
    }

    const previousIcon = retainedIcons.get(order);
    if (previousIcon) {
      previousIcon.remove();
    }
    retainedIcons.set(order, icon);
  }

  for (const [, icon] of [...retainedIcons].sort(
    ([leftOrder], [rightOrder]) => leftOrder - rightOrder,
  )) {
    document.head.appendChild(icon);
  }
}

export function StreamedIconsInsertion({ metadataKey }: { metadataKey: string }) {
  useLayoutEffect(() => reconcileStreamedIcons(metadataKey), [metadataKey]);
  return null;
}
