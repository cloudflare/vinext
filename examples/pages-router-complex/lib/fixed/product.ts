export const PRODUCT = "atlas";

/** Env-var scope under which this product's secrets are provisioned. */
export const CREDENTIAL_SCOPE = "ATLAS";

export const PRIMARY_REGION_ID = "primary-region";

export const LAUNCH_TIMER_FLAG = "launch_timer";
export const ARMED = "armed";

export const crumbFront = { label: "Front", href: "/" };
export const crumbJournal = { label: "Journal", href: "/journal" };

export const JournalTemplate = {
  STORY: "journal-story",
  WRITER: "journal-writer",
  THEME: "journal-theme",
} as const;

export const JournalBeacons = {
  StoryView: "story-view",
  WriterView: "writer-view",
} as const;
