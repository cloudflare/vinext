import { notFound } from "next/navigation";
import {
    DocsBody,
    DocsDescription,
    DocsPage,
    DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { source } from "../../../lib/source";

interface Props {
    params: Promise<{ slug?: string[] }>;
}

export default async function Page({ params }: Props) {
    const { slug } = await params;
    const page = source.getPage(slug);

    if (!page) {
        notFound();
    }

    const MDX = page.data.body;

    console.log("[vinext] Page rendering:", {
        slug: slug || [],
        pageUrl: page.url,
    });

    return (
        <DocsPage toc={page.data.toc}>
            <DocsTitle>{page.data.title}</DocsTitle>
            <DocsDescription>{page.data.description}</DocsDescription>
            <DocsBody>
                <MDX />
            </DocsBody>
        </DocsPage>
    );
}

export async function generateStaticParams() {
    return source.generateParams();
}
