type HtmlProxyRaceState = {
  firstRequestStarted: boolean;
  releaseFirstRequest: () => void;
  released: boolean;
  requestCount: number;
  waitForRelease: Promise<void>;
};

const races = new Map<string, HtmlProxyRaceState>();

function getRace(id: string): HtmlProxyRaceState {
  let race = races.get(id);
  if (race) return race;

  let releaseFirstRequest!: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  race = {
    firstRequestStarted: false,
    releaseFirstRequest,
    released: false,
    requestCount: 0,
    waitForRelease,
  };
  races.set(id, race);
  return race;
}

export async function enterHtmlProxyRace(id: string): Promise<"error" | "success"> {
  const race = getRace(id);
  race.requestCount += 1;
  if (race.requestCount !== 1) return "success";

  race.firstRequestStarted = true;
  await race.waitForRelease;
  return "error";
}

export async function enterInlineModuleRace(id: string): Promise<"first" | "second"> {
  const race = getRace(id);
  race.requestCount += 1;
  if (race.requestCount !== 1) return "second";

  race.firstRequestStarted = true;
  await race.waitForRelease;
  return "first";
}

export function getNonModuleVariant(id: string): "first-data" | "second-data" {
  const race = getRace(id);
  race.requestCount += 1;
  return race.requestCount === 1 ? "first-data" : "second-data";
}

export function getHtmlProxyRaceStatus(id: string) {
  const race = getRace(id);
  return {
    firstRequestStarted: race.firstRequestStarted,
    released: race.released,
    requestCount: race.requestCount,
  };
}

export function releaseHtmlProxyRace(id: string): void {
  const race = getRace(id);
  if (race.released) return;
  race.released = true;
  race.releaseFirstRequest();
}
