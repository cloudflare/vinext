import css from "styled-jsx/css";

// Styles defined outside the component that renders them, compiled through
// `styled-jsx/css` rather than an inline `<style jsx>` tag.
export const lateAccent = css.resolve`
  .late-accent {
    background: yellow;
  }
`;
