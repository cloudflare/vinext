import { describe, expect, it } from "vite-plus/test";
import { getRuntimePagesDataKind } from "../packages/vinext/src/server/pages-route-data-kind.js";

describe("getRuntimePagesDataKind", () => {
  it("uses the loaded page after HOCs and re-exports have run", () => {
    expect(getRuntimePagesDataKind({ default: { getInitialProps() {} } }, null)).toBe("initial");
  });

  it("detects custom _app getInitialProps but not the inherited default", () => {
    const inherited = () => ({});
    expect(
      getRuntimePagesDataKind({}, { getInitialProps: inherited, origGetInitialProps: inherited }),
    ).toBe("none");
    expect(
      getRuntimePagesDataKind({}, { getInitialProps() {}, origGetInitialProps: inherited }),
    ).toBe("initial");
  });

  it("keeps getStaticProps authoritative over _app and page initial props", () => {
    expect(
      getRuntimePagesDataKind(
        { default: { getInitialProps() {} }, getStaticProps() {} },
        { getInitialProps() {} },
      ),
    ).toBe("static");
  });

  it("classifies getServerSideProps as request-time", () => {
    expect(getRuntimePagesDataKind({ getServerSideProps() {} }, null)).toBe("server");
  });
});
