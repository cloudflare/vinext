// Shared in-memory guestbook store (not a server action)
const guestbook: string[] = [];

export function getGuestbookEntries(): string[] {
  return [...guestbook];
}

export function addEntry(name: string): void {
  guestbook.push(name);
}
