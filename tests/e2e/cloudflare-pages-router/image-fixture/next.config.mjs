export default {
  images: {
    maximumResponseBody: 100,
    minimumCacheTTL: 123,
    formats: ["image/avif", "image/webp"],
    qualities: [75, 90],
    unoptimized: process.env.TEST_IMAGE_UNOPTIMIZED === "1",
    loader: process.env.TEST_IMAGE_LOADER === "cloudinary" ? "cloudinary" : undefined,
  },
};
