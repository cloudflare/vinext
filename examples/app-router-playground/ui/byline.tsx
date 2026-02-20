import { Boundary } from '#/ui/boundary';

export default function Byline() {
  return (
    <Boundary kind="solid" animateRerendering={false}>
      <div className="flex gap-4 text-sm font-medium text-gray-600">
        <a
          className="transition-colors hover:text-gray-200"
          href="https://github.com/cloudflare/vinext/tree/main/examples/app-router-playground"
          target="_blank"
          rel="noreferrer"
        >
          Source code
        </a>
        <span className="text-gray-800">/</span>
        <a
          className="transition-colors hover:text-gray-200"
          href="https://nextjs.org/docs"
          target="_blank"
          rel="noreferrer"
        >
          Docs
        </a>
        <span className="text-gray-800">/</span>
        <a
          className="flex items-center gap-2 transition-colors hover:text-gray-200"
          href="https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/vinext/tree/main/examples/app-router-playground"
          target="_blank"
          rel="noreferrer"
        >
          Deploy to Cloudflare
        </a>
      </div>
    </Boundary>
  );
}
