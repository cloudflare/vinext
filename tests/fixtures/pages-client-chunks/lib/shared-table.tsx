import { SHARED_ROWS } from "./shared-rows";

// A small module that two pages share, beside the large rows it renders.
export function SharedTable() {
  return <table>{SHARED_ROWS.length}</table>;
}
