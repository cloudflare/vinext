let flag = false;

export function getFlag(): boolean {
  return flag;
}

export function setFlag(value: boolean): boolean {
  flag = value;
  return flag;
}
