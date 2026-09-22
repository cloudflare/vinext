import { redirect } from 'next/navigation';

async function redirectAction() {
  'use server';

  redirect('/redirect/destination');
}

export default function RedirectOriginPage() {
  return (
    <>
      {/* @ts-ignore */}
      <form action={redirectAction}>
        <button type="submit">Redirect me</button>
      </form>
    </>
  );
}
