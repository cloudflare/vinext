import { CommitDetail } from "../../components/commit-detail";

/**
 * Commit detail page — shows all benchmark data for a specific commit.
 */
export default function CommitPage({ params }: { params: { sha: string } }) {
  return (
    <div>
      <div className="mb-6">
        <a href="/" className="text-sm text-blue-600 hover:underline">
          &larr; Back to dashboard
        </a>
      </div>
      <CommitDetail sha={params.sha} />
    </div>
  );
}
