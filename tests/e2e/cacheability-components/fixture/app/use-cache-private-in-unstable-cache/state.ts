let privateExecutions = 0;

export function recordPrivateExecution(): number {
  return ++privateExecutions;
}

export function getPrivateExecutions(): number {
  return privateExecutions;
}
