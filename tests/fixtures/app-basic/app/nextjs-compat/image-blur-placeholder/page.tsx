import Image from "next/image";

const blurDataURL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw0K5QAAAABJRU5ErkJggg==";

export default function ImageBlurPlaceholderPage() {
  return (
    <main>
      <h1>Image Blur Placeholder</h1>
      <Image
        id="transparent-image"
        alt="transparent image"
        src="/transparent-image.svg"
        width={64}
        height={64}
        placeholder="blur"
        blurDataURL={blurDataURL}
        priority
      />
    </main>
  );
}
