/**
 * Nimiq money formatting — Phase 1A foundation.
 *
 * All arithmetic is integer arithmetic on luna (1 NIM = 100,000 luna). Every
 * function here is exact: no floats ever touch a balance, so a fee, a parse
 * or a display never drifts by 0.000000001 NIM. Values cross the boundary as
 * bigint luna; humans write "12.34 NIM".
 */

/** 1 NIM in luna, as an exact bigint. */
export const LUNA_PER_NIM = 100_000n;

/** NIM has 5 decimal places (luna). */
export const NIM_DECIMALS = 5;

/** Thrown when a value cannot be represented exactly. */
export class NimiqMoneyError extends Error {}

/** Guard: is this a real bigint? (JSON parsing can hand back numbers/strings.) */
function assertBigint(value: bigint | number | string, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new NimiqMoneyError(`${label} is not an exact integer luna value: ${String(value)}`);
}

/**
 * Format luna as a human NIM string, exact to the luna.
 * formatNim(123450n) → "1.2345" · formatNim(1n) → "0.00001" · negative keeps sign.
 */
export function formatNim(luna: bigint | number | string): string {
  const v = assertBigint(luna, "luna value");
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / LUNA_PER_NIM;
  const frac = abs % LUNA_PER_NIM;
  const fracStr = frac.toString().padStart(NIM_DECIMALS, "0").replace(/0+$/, "");
  const body = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Format with a fixed number of decimals (trailing zeros kept), e.g. tables. */
export function formatNimFixed(luna: bigint | number | string, decimals = 2): string {
  const v = assertBigint(luna, "luna value");
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / LUNA_PER_NIM;
  const frac = (abs % LUNA_PER_NIM).toString().padStart(NIM_DECIMALS, "0");
  const clipped = decimals <= 0 ? "" : `.${frac.slice(0, Math.min(decimals, NIM_DECIMALS)).padEnd(Math.min(decimals, NIM_DECIMALS), "0")}`;
  return `${negative ? "-" : ""}${whole}${clipped}`;
}

/**
 * Parse a human NIM amount into exact luna. Accepts "12.34", "12", ".5",
 * "1.00001" and optional thousands separators (spaces, apostrophes, commas,
 * underscores). Rejects anything that is not exactly representable in luna —
 * never rounds, never truncates silently.
 */
export function parseNim(input: string): bigint {
  const cleaned = input.trim().replace(/[ _',]/g, "");
  const match = /^(-)?(\d+)?(?:\.(\d+))?$/.exec(cleaned);
  if (!match || (!match[2] && !match[3])) {
    throw new NimiqMoneyError(`Not a NIM amount: "${input}"`);
  }
  const negative = match[1] === "-";
  const whole = match[2] ?? "0";
  const frac = (match[3] ?? "").slice(0, NIM_DECIMALS);
  if ((match[3] ?? "").length > NIM_DECIMALS) {
    throw new NimiqMoneyError(`More than ${NIM_DECIMALS} decimals: "${input}"`);
  }
  const fracPadded = frac.padEnd(NIM_DECIMALS, "0");
  const luna = BigInt(whole) * LUNA_PER_NIM + BigInt(fracPadded || "0");
  return negative ? -luna : luna;
}

/** Exact sum of a list of luna values (JSON stores may hand strings back). */
export function sumLuna(values: Array<bigint | number | string>): bigint {
  return values.reduce<bigint>((acc, v) => acc + assertBigint(v, "luna value"), 0n);
}

/** Coerce a JSON-decoded luna value (number|string|bigint) to exact bigint. */
export function toLuna(value: bigint | number | string): bigint {
  return assertBigint(value, "luna value");
}
