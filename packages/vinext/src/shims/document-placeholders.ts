/**
 * Per-render placeholders for the Pages Router `next/document` shims.
 *
 * The renderers splice the page body, `next/head` output, asset tags and
 * hydration scripts into the serialized custom Document. Each render provides
 * a fresh random token, and `<Head>`, `<Main />` and `<NextScript />` mark
 * their splice points with it. No value the Document renders — request data
 * included, even inside raw `<script>` text — can know the token, so none can
 * be mistaken for a splice point.
 */
import React from "react";

export const DocumentPlaceholderContext = React.createContext<string | null>(null);

/** Attribute `<Head>` adds last on its opening tag. */
export const DOCUMENT_HEAD_OPEN_ATTRIBUTE = "data-vinext-head-open";
/** Attribute of the `<template>` `<Head>` renders as its last child. */
export const DOCUMENT_HEAD_CLOSE_ATTRIBUTE = "data-vinext-head-close";

export function createDocumentPlaceholderToken(): string {
  return crypto.randomUUID();
}

export function withDocumentPlaceholders(
  element: React.ReactElement,
  token: string,
): React.ReactElement {
  return React.createElement(DocumentPlaceholderContext.Provider, { value: token }, element);
}

/**
 * `<Main />`'s placeholder. Without a renderer-provided token (a Document
 * rendered on its own, e.g. in tests) it falls back to a static comment.
 */
export function getDocumentMainPlaceholder(token: string | null): string {
  return token ? `<!--__NEXT_MAIN__:${token}-->` : "<!-- __NEXT_MAIN__ -->";
}

export function getDocumentScriptsPlaceholder(token: string | null): string {
  return token ? `<!--__NEXT_SCRIPTS__:${token}-->` : "<!-- __NEXT_SCRIPTS__ -->";
}

export function getDocumentHeadOpenMarker(token: string): string {
  return ` ${DOCUMENT_HEAD_OPEN_ATTRIBUTE}="${token}">`;
}

export function getDocumentHeadCloseMarker(token: string): string {
  return `<template ${DOCUMENT_HEAD_CLOSE_ATTRIBUTE}="${token}"></template>`;
}
