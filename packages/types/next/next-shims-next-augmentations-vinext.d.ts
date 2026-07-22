import "next/dist/shared/lib/app-router-context.shared-runtime";

declare module "next/dist/shared/lib/app-router-context.shared-runtime" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation requires interface merging
  interface AppRouterInstance {
    readonly bfcacheId: string;
  }
}
