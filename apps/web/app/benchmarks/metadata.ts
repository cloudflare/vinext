import type { Metadata } from "next";

type BenchmarkMetadataOptions = {
  title: string;
  description: string;
  path: string;
  index?: boolean;
};

export function createBenchmarkMetadata({
  title,
  description,
  path,
  index = true,
}: BenchmarkMetadataOptions): Metadata {
  // The root layout templates the document title as `%s — vinext`; openGraph and
  // twitter titles are not templated, so they still need the brand spelled out.
  const brandedTitle = `${title} — vinext`;
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: index ? undefined : { index: false, follow: true },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "vinext",
      title: brandedTitle,
      description,
      url: path,
    },
    twitter: {
      title: brandedTitle,
      description,
    },
  };
}
