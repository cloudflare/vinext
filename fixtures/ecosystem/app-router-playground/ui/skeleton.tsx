import clsx from 'clsx';

export function SkeletonText({
  count = 10,
  minLength = 2,
  maxLength = 12,
  className = '',
  seed: _seed = '',
}: {
  count?: number;
  minLength?: number;
  maxLength?: number;
  className?: string;
  seed?: string;
}) {
  const words = Array.from({ length: count }, (_, i) => {
    const seed = _seed + count + i;

    return Math.floor(random(seed) * (maxLength - minLength + 1)) + minLength;
  });

  return (
    <div
      className={clsx('flex flex-wrap gap-x-[1ch] gap-y-[0.65em]', className)}
    >
      {words.map((width, i) => (
        <div
          key={i}
          className="h-[0.6em] rounded-full bg-current"
          style={{ width: `${width}ch` }}
        />
      ))}
    </div>
  );
}

// Yoinked from https://github.com/remotion-dev/remotion/blob/main/packages/core/src/random.ts
function mulberry32(a: number) {
  let t = a + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hashCode(str: string) {
  let i = 0;
  let chr = 0;
  let hash = 0;

  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }

  return hash;
}

type RandomSeed = number | string;

export const random = (seed: RandomSeed) => {
  if (typeof seed === 'string') {
    return mulberry32(hashCode(seed));
  }

  if (typeof seed === 'number') {
    return mulberry32(seed * 10000000000);
  }

  throw new Error('random() argument must be a number or a string');
};
