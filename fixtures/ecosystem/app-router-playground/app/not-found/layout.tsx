'use cache';

import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { Tabs } from '#/ui/tabs';
import { type Metadata } from 'next';
import React from 'react';
import Readme from './readme.mdx';
import { Mdx } from '#/ui/codehike';

export async function generateMetadata(): Promise<Metadata> {
  const demo = db.demo.find({ where: { slug: 'not-found' } });

  return {
    title: demo.name,
    openGraph: { title: demo.name, images: [`/api/og?title=${demo.name}`] },
  };
}

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const demo = db.demo.find({ where: { slug: 'not-found' } });
  const sections = db.section.findMany({ limit: 1 });

  return (
    <>
      <Boundary label="Demo" kind="solid" animateRerendering={false}>
        <Mdx source={Readme} collapsed={true} />
      </Boundary>

      <Boundary
        label="layout.tsx"
        kind="solid"
        animateRerendering={false}
        className="flex flex-col gap-9"
      >
        <Tabs
          basePath={`/${demo.slug}`}
          items={[
            { text: 'Home' },
            ...sections.map((x) => ({ text: x.name, slug: x.slug })),
            { text: 'Does Not Exist', slug: 'does-not-exist' },
          ]}
        />

        {children}
      </Boundary>
    </>
  );
}
