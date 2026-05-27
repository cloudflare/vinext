// this should be temporary until fixing why the export is not detected correctly

import { jsx } from "react/jsx-runtime"
import { HtmlDiff } from "@payloadcms/ui/elements/HTMLDiff/diff"

const baseClass = "html-diff"

const escapeMap = {
  '"': "\uE004",
  "&": "\uE001",
  "'": "\uE005",
  "<": "\uE002",
  ">": "\uE003",
}

const unescapeMap = {
  "\uE001": "&amp;",
  "\uE002": "&lt;",
  "\uE003": "&gt;",
  "\uE004": "&quot;",
  "\uE005": "&#39;",
}

export function escapeDiffHTML(value: unknown) {
  if (value == null) {
    return ""
  }

  const stringValue = typeof value === "string" ? value : String(value)

  return stringValue
    .replace(/&/g, escapeMap["&"])
    .replace(/</g, escapeMap["<"])
    .replace(/>/g, escapeMap[">"])
    .replace(/"/g, escapeMap['"'])
    .replace(/'/g, escapeMap["'"])
}

export function unescapeDiffHTML(html: string) {
  return html
    .replace(/\uE001/g, unescapeMap["\uE001"])
    .replace(/\uE002/g, unescapeMap["\uE002"])
    .replace(/\uE003/g, unescapeMap["\uE003"])
    .replace(/\uE004/g, unescapeMap["\uE004"])
    .replace(/\uE005/g, unescapeMap["\uE005"])
}

export function getHTMLDiffComponents({
  fromHTML,
  postProcess,
  toHTML,
  tokenizeByCharacter,
}: {
  fromHTML: string
  postProcess?: (html: string) => string
  toHTML: string
  tokenizeByCharacter?: boolean
}) {
  const diffHTML = new HtmlDiff(fromHTML, toHTML, {
    tokenizeByCharacter,
  })
  let [oldHTML, newHTML] = diffHTML.getSideBySideContents()

  if (postProcess) {
    oldHTML = postProcess(oldHTML)
    newHTML = postProcess(newHTML)
  }

  return {
    From: oldHTML
      ? jsx("div", {
          className: `${baseClass}__diff-old html-diff`,
          dangerouslySetInnerHTML: {
            __html: oldHTML,
          },
        })
      : null,
    To: newHTML
      ? jsx("div", {
          className: `${baseClass}__diff-new html-diff`,
          dangerouslySetInnerHTML: {
            __html: newHTML,
          },
        })
      : null,
  }
}
