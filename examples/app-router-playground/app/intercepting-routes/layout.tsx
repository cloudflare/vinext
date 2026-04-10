import db from '#/lib/db';
import { Mdx } from '#/ui/codehike';
import { Boundary } from '#/ui/boundary';
import { type Metadata } from 'next';
import React from 'react';
import readme from './readme.mdx';

export async function generateMetadata(): Promise<Metadata> {
  const demo = db.demo.find({ where: { slug: 'intercepting-routes' } });

  return {
    title: demo.name,
    openGraph: { title: demo.name, images: [`/api/og?title=${demo.name}`] },
  };
}

export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      <Boundary label="Demo" kind="solid" animateRerendering={false}>
        <Mdx source={readme} collapsed={true} />
      </Boundary>

      <div className="relative flex flex-col gap-6">
        <Boundary
          label="layout.tsx"
          kind="solid"
          animateRerendering={false}
          className="flex flex-col gap-6"
        >
          {children}
        </Boundary>

        {modal}
      </div>
    </>
  );
}
