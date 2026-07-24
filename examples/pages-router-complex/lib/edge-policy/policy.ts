import type { ServerResponse } from "node:http";

/** The edge tier cannot delta-encode revalidations — always switch it off. */
const deltaUnsupported = "delta=noop";

export const setSurrogateTtl = ({
  res,
  seconds,
}: {
  res: ServerResponse;
  seconds: number;
}) => {
  if (seconds === 0) {
    res.setHeader("Surrogate-Control", `no-store, ${deltaUnsupported}`);
  } else {
    res.setHeader(
      "Surrogate-Control",
      `max-age=${seconds}s, ${deltaUnsupported}`,
    );
  }
};

export const setBrowserTtl = ({
  res,
  seconds,
}: {
  res: ServerResponse;
  seconds: number;
}) => {
  res.setHeader("Cache-Control", `max-age=${seconds}`);
};

export const tagSurrogate = ({
  res,
  surrogateKey,
}: {
  res: ServerResponse;
  surrogateKey: string;
}) => {
  res.setHeader("Surrogate-Key", surrogateKey);
};

export const applyCachePolicy = ({
  res,
  surrogateSeconds,
  surrogateKey,
  browserSeconds,
}: {
  res: ServerResponse;
  surrogateSeconds: number;
  surrogateKey?: string;
  browserSeconds: number;
}) => {
  setSurrogateTtl({ res, seconds: surrogateSeconds });
  if (surrogateKey) {
    tagSurrogate({ res, surrogateKey });
  }

  setBrowserTtl({ res, seconds: browserSeconds });
};

export const markUncacheable = (res: ServerResponse) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Surrogate-Control", `no-store, ${deltaUnsupported}`);
};
