import type { GetServerSideProps } from "next/types";
import Head from "next/head";
import Link from "next/link";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { applyCachePolicy } from "@atlas/edge-policy/policy";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";

export type JournalFrontProps = PageLiftedProps & {
  stories: { slug: string; title: string }[];
};

const JournalFront = ({ stories }: JournalFrontProps) => (
  <>
    <Head>
      <title>Journal | atlas</title>
    </Head>
    <section data-testid="journal-front">
      <h1>The journal</h1>
      <ul>
        {stories.map((story) => (
          <li key={story.slug}>
            <Link href={`/journal/${story.slug}`}>{story.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  </>
);

const pageData: GetServerSideProps<JournalFrontProps> = async (context) => {
  applyCachePolicy({
    res: context.res,
    surrogateSeconds: 3600,
    browserSeconds: 300,
  });

  return {
    props: {
      stories: [
        { slug: "about", title: "About the atlas" },
        { slug: "night-navigation", title: "Navigating by night" },
      ],
      lifted: {
        viewKind: ViewKind.STORY,
        renderedAtMs: Date.now(),
      },
    },
  };
};

export const getServerSideProps = meterServerProps(pageData);

export default JournalFront;
