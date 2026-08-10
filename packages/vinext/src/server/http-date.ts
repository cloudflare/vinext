const IMF_FIXDATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE_RE =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: (\d)|(\d{2})) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Sunday: 0,
  Mon: 1,
  Monday: 1,
  Tue: 2,
  Tuesday: 2,
  Wed: 3,
  Wednesday: 3,
  Thu: 4,
  Thursday: 4,
  Fri: 5,
  Friday: 5,
  Sat: 6,
  Saturday: 6,
};
const MONTH_INDEX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** Parse only the three HTTP-date wire formats accepted by RFC 9110. */
export function parseHttpDate(value: string): number {
  const imf = IMF_FIXDATE_RE.exec(value);
  if (imf) {
    return timestampFromHttpDateParts(imf[1], imf[2], imf[3], imf[4], imf[5], imf[6], imf[7]);
  }

  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850) {
    const now = new Date();
    let year = now.getUTCFullYear() - (now.getUTCFullYear() % 100) + Number(rfc850[4]);
    const candidateTimestamp = timestampForRfc850YearWindow(
      rfc850[2],
      rfc850[3],
      String(year),
      rfc850[5],
      rfc850[6],
      rfc850[7],
    );
    const fiftyYearsFromNow = new Date(now);
    fiftyYearsFromNow.setUTCFullYear(now.getUTCFullYear() + 50);
    if (candidateTimestamp > fiftyYearsFromNow.getTime()) year -= 100;
    return timestampFromHttpDateParts(
      rfc850[1],
      rfc850[2],
      rfc850[3],
      String(year),
      rfc850[5],
      rfc850[6],
      rfc850[7],
    );
  }

  const asctime = ASCTIME_DATE_RE.exec(value);
  if (asctime) {
    return timestampFromHttpDateParts(
      asctime[1],
      asctime[3] || asctime[4],
      asctime[2],
      asctime[8],
      asctime[5],
      asctime[6],
      asctime[7],
    );
  }

  return Number.NaN;
}

function timestampForRfc850YearWindow(
  dayValue: string,
  monthValue: string,
  yearValue: string,
  hourValue: string,
  minuteValue: string,
  secondValue: string,
): number {
  // Normalize solely for the 50-year comparison. Final calendar and weekday
  // validation happens after the RFC 850 century adjustment.
  const date = new Date(0);
  date.setUTCFullYear(Number(yearValue), MONTH_INDEX[monthValue], Number(dayValue));
  date.setUTCHours(Number(hourValue), Number(minuteValue), Number(secondValue), 0);
  return date.getTime();
}

function timestampFromHttpDateParts(
  weekday: string | undefined,
  dayValue: string,
  monthValue: string,
  yearValue: string,
  hourValue: string,
  minuteValue: string,
  secondValue: string,
): number {
  const day = Number(dayValue);
  const month = MONTH_INDEX[monthValue];
  const year = Number(yearValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);

  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    (weekday !== undefined && date.getUTCDay() !== WEEKDAY_INDEX[weekday])
  ) {
    return Number.NaN;
  }
  return date.getTime();
}
