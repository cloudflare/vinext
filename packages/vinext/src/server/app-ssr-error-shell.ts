import { createElement as createReactElement, type ReactNode } from "react";
import DefaultGlobalError from "vinext/shims/default-global-error";
import { createNonceAttribute, escapeHtmlAttr } from "./html.js";

type RenderStaticMarkup = (element: ReactNode) => string;

const DOCUMENT_CLOSE = "</body></html>";

function buildBootstrapModuleScript(bootstrapModuleUrl?: string, nonce?: string): string {
  if (!bootstrapModuleUrl) return "";
  return (
    `<script type="module"${createNonceAttribute(nonce)} src="` +
    escapeHtmlAttr(bootstrapModuleUrl) +
    '" id="_R_" async=""></script>'
  );
}

export function renderSsrErrorDocumentShellHtml(
  renderStaticMarkup: RenderStaticMarkup,
  bootstrapModuleUrl?: string,
  nonce?: string,
): string {
  const html = renderStaticMarkup(
    createReactElement(DefaultGlobalError, {
      error: null,
    }),
  ).replace("<style>", '<style data-vinext-error-shell-style="">');
  const bootstrapScript = buildBootstrapModuleScript(bootstrapModuleUrl, nonce);
  if (!bootstrapScript) {
    return `<!DOCTYPE html>${html}`;
  }

  if (!html.endsWith(DOCUMENT_CLOSE)) {
    return `<!DOCTYPE html>${html}${bootstrapScript}`;
  }

  return `<!DOCTYPE html>${html.slice(0, -DOCUMENT_CLOSE.length)}${bootstrapScript}${DOCUMENT_CLOSE}`;
}
