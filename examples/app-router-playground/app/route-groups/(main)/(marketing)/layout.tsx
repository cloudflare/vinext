import { Boundary } from '#/ui/boundary';
import React from 'react';

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Boundary label="(main)(marketing)/layout.tsx">{children}</Boundary>;
}
