import { ActionButton } from "../../action-button";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ value?: string }>;
}) {
  const value = (await searchParams).value ?? "public";
  const oracleAction = async () => {
    "use server";
    return `ORACLE:${value}`;
  };

  return <ActionButton id="oracle" action={oracleAction} />;
}
