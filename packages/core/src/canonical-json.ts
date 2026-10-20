/**
 * RFC 8785 JSON Canonicalization Scheme (JCS): keys sorted by UTF-16 code units, no whitespace,
 * `undefined` properties omitted, numbers in ECMAScript `Number.prototype.toString` form (which is
 * what `JSON.stringify` emits for a finite number, -0 included as `0`).
 *
 * `numbers: "integer"` narrows the value space to safe integers. Registry and bundle digests use it,
 * so a producer cannot make two serializers disagree on a float. `"finite"` admits every finite
 * number; composition digests use it because an AgentSpec carries `chars_per_token` and
 * `max_cost_usd`. NaN and ±Infinity have no JSON form and are refused in both.
 *
 * Not the same function as `canonicalJson` in fingerprint.ts, whose output is a stored v1
 * fingerprint and must not change.
 */

export type JcsNumbers = "integer" | "finite";

/** An unpaired UTF-16 surrogate: RFC 8785 rejects it, and UTF-8 encoding silently turns it into U+FFFD. */
export const hasLoneSurrogate = (text: string) => /\p{Cs}/u.test(text);

export function jcs(value: unknown, numbers: JcsNumbers = "finite"): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (numbers === "integer" && !Number.isSafeInteger(value)) throw new Error("canonicalJson: non-integer numbers are not part of the digested value space");
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite numbers have no JSON form");
    }
    if (typeof value === "string" && hasLoneSurrogate(value)) throw new Error("canonicalJson: strings must not contain an unpaired surrogate");
    const text = JSON.stringify(value);
    // undefined, functions and symbols: JSON has no form for them outside an object member.
    if (text === undefined) throw new Error(`canonicalJson: ${typeof value} has no JSON form`);
    return text;
  }
  if (Array.isArray(value)) return `[${value.map((v) => jcs(v, numbers)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${jcs(k, numbers)}:${jcs(v, numbers)}`).join(",")}}`;
}
