import { useEffect } from "react";

import type { GetServerSideProps } from "next/types";
import Head from "next/head";

import { emitBeacon } from "@atlas/beacon/emit";
import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { applyCachePolicy } from "@atlas/edge-policy/policy";
import {
  crumbFront,
  crumbJournal,
  JournalBeacons,
  JournalTemplate,
} from "@atlas/fixed/product";
import type { LiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";

export type StoryPageProps = {
  slug: string | string[];
  story: { title: string; body: string; byline?: string };
  lifted: Pick<LiftedProps, "viewKind" | "renderedAtMs">;
};

const StoryPage = ({ slug, story }: StoryPageProps) => {
  useEffect(() => {
    emitBeacon(JournalBeacons.StoryView, {
      template: JournalTemplate.STORY,
      detail: story.title || "Unknown story",
      storyRef: Array.isArray(slug) ? slug[0] : slug,
    });
  }, [slug, story.title]);

  return (
    <>
      <Head>
        <title>{`${story.title} | atlas journal`}</title>
      </Head>
      <nav aria-label="Breadcrumbs">
        <a href={crumbFront.href}>{crumbFront.label}</a> /{" "}
        <a href={crumbJournal.href}>{crumbJournal.label}</a>
      </nav>
      <article data-testid="journal-story">
        <h1>{story.title}</h1>
        {story.byline && <p data-testid="story-byline">{story.byline}</p>}
        <p>{story.body}</p>
      </article>
    </>
  );
};

const KNOWN_STORIES: Record<
  string,
  { title: string; body: string; byline?: string }
> = {
  about: { title: "About the atlas", body: "Everything about this fixture." },
  contact: { title: "Contact", body: "How to reach the atlas desk." },
  "night-navigation": {
    title: "Navigating by night",
    body: "Long-form piece on wayfinding.",
    byline: "By Rowan",
  },
};

export type StoryPageParams = { story: string };
export type StoryPageDraftData = { ref: string | undefined };

const pageData: GetServerSideProps<
  StoryPageProps,
  StoryPageParams,
  StoryPageDraftData
> = async (context) => {
  applyCachePolicy({
    res: context.res,
    surrogateSeconds: 3600,
    browserSeconds: 300,
  });

  const slug = context.params?.story ?? "";
  const story = KNOWN_STORIES[slug];

  if (!story) {
    return { notFound: true };
  }

  return {
    props: {
      slug,
      story: context.draftMode
        ? { ...story, title: `${story.title} (draft)` }
        : story,
      lifted: {
        viewKind: ViewKind.STORY,
        renderedAtMs: Date.now(),
      },
    },
  };
};

export const getServerSideProps = meterServerProps(pageData);

export default StoryPage;
