const CDN_ORIGIN = "https://cdn.atlas-fixture.test";

const TYPEFACE_FILES = ["atlas-grotesk-regular.woff2", "atlas-grotesk-bold.woff2"];

export const TypefacePreloads = () => (
  <>
    {TYPEFACE_FILES.map((file) => (
      <link
        key={file}
        rel="preload"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
        href={`${CDN_ORIGIN}/typefaces/${file}`}
      />
    ))}
  </>
);
