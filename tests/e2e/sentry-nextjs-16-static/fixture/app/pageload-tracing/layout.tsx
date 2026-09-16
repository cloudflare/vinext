import { PropsWithChildren } from 'react';

export const dynamic = 'force-dynamic';

export default async function Layout({ children }: PropsWithChildren<unknown>) {
  await new Promise(resolve => setTimeout(resolve, 500));
  return <>{children}</>;
}
