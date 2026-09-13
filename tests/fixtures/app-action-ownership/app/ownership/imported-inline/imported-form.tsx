import { ActionButton } from "../action-button";
export function ImportedForm() {
  const importedInlineAction = async () => {
    "use server";
    return "IMPORTED_INLINE_OK";
  };
  return <ActionButton id="imported-inline" action={importedInlineAction} />;
}
