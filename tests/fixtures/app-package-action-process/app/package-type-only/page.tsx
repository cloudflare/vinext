import { PackageActionLabel } from "dev-package-action/type-only";
import { packageTypeOnlyLabel } from "dev-package-action/type-only-reexport";

const label: PackageActionLabel = packageTypeOnlyLabel;

export default function PackageTypeOnlyPage() {
  return <p>{label}</p>;
}
