import { ImageResponse } from "next/og";

export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

type OgImageProps = {
  title: string;
  description: string;
  /** Left-hand footer text, such as the publish date and author. */
  footer: string;
};

async function loadFonts() {
  const [regular, semiBold] = await Promise.all([
    fetch(new URL("../../assets/fonts/Geist-Regular.ttf", import.meta.url)).then((res) =>
      res.arrayBuffer(),
    ),
    fetch(new URL("../../assets/fonts/Geist-SemiBold.ttf", import.meta.url)).then((res) =>
      res.arrayBuffer(),
    ),
  ]);
  return [
    { name: "Geist", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Geist", data: semiBold, weight: 600 as const, style: "normal" as const },
  ];
}

/** Render the shared social card used by the blog index and every post. */
export async function renderBlogOgImage({ title, description, footer }: OgImageProps) {
  const titleSize = title.length > 70 ? 54 : title.length > 40 ? 64 : 76;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        fontFamily: "Geist",
        color: "#fafafa",
        backgroundColor: "#09090b",
        backgroundImage:
          "radial-gradient(circle at 88% 0%, rgba(59, 130, 246, 0.35), transparent 45%), radial-gradient(circle at 0% 100%, rgba(249, 115, 22, 0.22), transparent 40%)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", fontSize: 36 }}>
        <span style={{ fontWeight: 600, letterSpacing: "-0.02em" }}>Vinext</span>
        <span style={{ marginLeft: 14, color: "#71717a" }}>/ blog</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontSize: titleSize,
            fontWeight: 600,
            lineHeight: 1.08,
            letterSpacing: "-0.035em",
            lineClamp: 3,
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: 28,
            fontSize: 30,
            lineHeight: 1.4,
            color: "#a1a1aa",
            lineClamp: 2,
          }}
        >
          {description}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 26,
          color: "#a1a1aa",
          borderTop: "1px solid #27272a",
          paddingTop: 28,
        }}
      >
        <span>{footer}</span>
        <span style={{ color: "#fafafa", fontWeight: 600 }}>vinext.dev</span>
      </div>
    </div>,
    { ...OG_IMAGE_SIZE, fonts: await loadFonts() },
  );
}
