declare module "virtual:vinext-readme" {
  /** Built by ./readme-html.ts at build time from the repo-root README.md. */
  const readme: {
    html: string;
    headings: { depth: number; text: string; slug: string }[];
    sourceUrl: string;
  };
  export default readme;
}
