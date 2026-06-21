import css from "styled-jsx/css";

const accent: string = "hotpink";

export const externalElementStyles = css`
  .external-element {
    background: yellow;
  }
`;

export const externalStyles = css.resolve`
  .external {
    color: ${accent};
  }
`;
