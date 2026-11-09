type Props = {
  title: string;
  description: string;
  href: string;
};

export default function ExternalLink({description, href, title}: Props) {
  return (
    <a
      className="inline-block rounded-md border border-gray-700 p-8 transition-colors hover:border-gray-400"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      <p className="text-xl font-semibold text-white">
        {title} <span className="ml-2 inline-block">→</span>
      </p>
      <p className="mt-2 max-w-[250px] text-gray-400">{description}</p>
    </a>
  );
}
