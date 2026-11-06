import Document, { type DocumentContext } from "next/document";

export default class CustomDocument extends Document {
  static async getInitialProps(ctx: DocumentContext) {
    const props = await Document.getInitialProps(ctx);
    if (ctx.pathname === "/accepted" && ctx.res) {
      ctx.res.statusCode = 202;
      ctx.res.setHeader("Content-Type", "application/xhtml+xml; charset=utf-8");
      ctx.res.setHeader("Set-Cookie", "build-only=do-not-replay");
    }
    return props;
  }
}
