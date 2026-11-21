import { createElement } from "react";

export const glyph = (name, path) => {
  const Glyph = ({ size = 16, title }) =>
    createElement(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        role: title ? "img" : "presentation",
        "aria-label": title,
        "data-glyph": name,
      },
      createElement("path", { d: path, fill: "currentColor" }),
    );
  Glyph.displayName = `${name}Glyph`;
  return Glyph;
};
