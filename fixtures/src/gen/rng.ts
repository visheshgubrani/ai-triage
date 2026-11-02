/** mulberry32: a small seeded PRNG, so the generator produces the same documents every run. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  return { next, int, pick };
}
export type Rng = ReturnType<typeof createRng>;

export const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const round2 = (n: number) => Math.round(n * 100) / 100;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** An ISO date as written in a document, in one of three styles. */
export function writtenDate(iso: string, style: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const month = MONTHS[m - 1];
  if (style % 3 === 0) return iso;
  if (style % 3 === 1) return `${month} ${d}, ${y}`;
  return `${d} ${month} ${y}`;
}

export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isoDate(rng: Rng, from = "2026-01-05", spanDays = 280): string {
  return addDays(from, rng.int(0, spanDays));
}

/** RFC 2822 date header for a fixture email. */
export function mailDate(iso: string, hour: number): string {
  const date = new Date(`${iso}T${String(hour).padStart(2, "0")}:15:00Z`);
  return date.toUTCString().replace("GMT", "+0000");
}
