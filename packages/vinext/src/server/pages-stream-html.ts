export function insertHtmlAfterPagesRoot(shellSuffix: string, html: string): string {
  if (!html) return shellSuffix;

  const closingRootStart = shellSuffix.toLowerCase().indexOf("</div");
  if (closingRootStart === -1) return html + shellSuffix;

  const closingRootEnd = shellSuffix.indexOf(">", closingRootStart);
  if (closingRootEnd === -1) return html + shellSuffix;

  return shellSuffix.slice(0, closingRootEnd + 1) + html + shellSuffix.slice(closingRootEnd + 1);
}
