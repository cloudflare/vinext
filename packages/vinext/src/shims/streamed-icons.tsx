"use client";

import { useLayoutEffect } from "react";

const STREAMED_ICON_ATTRIBUTE = "data-vinext-streamed-icon";
const STREAMED_ICON_ORDER_ATTRIBUTE = "data-vinext-streamed-icon-order";

export function reconcileStreamedIcons(metadataKey: string): void {
  document
    .querySelectorAll<HTMLLinkElement>(`body link[${STREAMED_ICON_ATTRIBUTE}]`)
    .forEach((icon) => document.head.appendChild(icon));

  const ownedIcons = [
    ...document.querySelectorAll<HTMLLinkElement>(`head link[${STREAMED_ICON_ATTRIBUTE}]`),
  ];
  const retainedIcons = new Map<number, HTMLLinkElement>();

  for (const icon of ownedIcons) {
    if (icon.getAttribute(STREAMED_ICON_ATTRIBUTE) !== metadataKey) {
      icon.remove();
      continue;
    }

    const order = Number(icon.getAttribute(STREAMED_ICON_ORDER_ATTRIBUTE));
    const previousIcon = retainedIcons.get(order);
    if (previousIcon) {
      previousIcon.remove();
    }
    retainedIcons.set(order, icon);
  }

  for (const [order, icon] of [...retainedIcons].sort(
    ([leftOrder], [rightOrder]) => leftOrder - rightOrder,
  )) {
    if (!Number.isFinite(order)) {
      continue;
    }
    document.head.appendChild(icon);
  }
}

export function StreamedIconsInsertion({ metadataKey }: { metadataKey: string }) {
  useLayoutEffect(() => reconcileStreamedIcons(metadataKey), [metadataKey]);
  return null;
}
