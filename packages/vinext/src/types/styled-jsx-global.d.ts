import "react";

declare module "react" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Interface merging is required to augment React's attributes.
  interface StyleHTMLAttributes<T> extends HTMLAttributes<T> {
    jsx?: boolean;
    global?: boolean;
  }
}
