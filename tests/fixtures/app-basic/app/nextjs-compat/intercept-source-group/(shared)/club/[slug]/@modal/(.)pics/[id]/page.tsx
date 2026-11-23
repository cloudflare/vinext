import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata = { title: "Pic modal" };

async function openSecondPic() {
  "use server";
  redirect("/nextjs-compat/intercept-source-group/club/static/pics/2");
}

export default async function PicModal({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  return (
    <>
      <p id="intercept-source-group-modal">Pic modal: {id}</p>
      <p id="intercept-source-group-modal-club">Modal club: {slug}</p>
      <form action={openSecondPic}>
        <button id="intercept-source-group-modal-next" type="submit">
          Second pic
        </button>
      </form>
      <Link href="/nextjs-compat/intercept-source-group/peek">Peek</Link>
    </>
  );
}
