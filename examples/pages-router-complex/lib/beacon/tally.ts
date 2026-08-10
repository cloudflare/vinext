/**
 * In-process HTTP tallies. A production deployment would export these to a
 * metrics collector; here they accumulate in module state so operational
 * endpoints (and tests) can observe them.
 */

export type RequestTally = {
  path: string;
  method: string;
  fromCrawler: boolean;
  statusCode: number;
};

const tallies = new Map<string, number>();

const tallyKey = (t: RequestTally) =>
  `${t.method} ${t.path.split("?")[0]} ${t.statusCode} crawler=${t.fromCrawler}`;

export const bumpRequestTally = (tally: RequestTally): void => {
  const key = tallyKey(tally);
  tallies.set(key, (tallies.get(key) ?? 0) + 1);
};

export const requestTallies = (): Record<string, number> =>
  Object.fromEntries(tallies);

const CRAWLER_UA_PATTERN = /bot|crawl|spider|slurp|headless/i;

export const looksLikeCrawler = (userAgent: string | undefined): boolean =>
  !!userAgent && CRAWLER_UA_PATTERN.test(userAgent);
