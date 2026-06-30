import { RevalidateButton } from "../revalidate-button.js";

export const revalidate = 900;

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const generatedAt = new Date().toISOString();

  return (
    <div>
      <span id="generated-at">{generatedAt}</span>
      <span id="lang">{lang}</span>
      <RevalidateButton lang={lang} />
    </div>
  );
}
