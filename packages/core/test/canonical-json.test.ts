import { describe, expect, it } from "vitest";
import { canonicalJson, hasLoneSurrogate, jcs } from "../src/index.js";

describe("jcs (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)", () => {
    const value = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    // Read the order from the text: a parsed object would move the integer-like key "1" first.
    const keys = [...jcs(value).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(keys).toEqual(["\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);
  });

  it("writes finite numbers in ECMAScript form (RFC 8785 §3.2.2.3)", () => {
    const cases: Array<[number, string]> = [
      [0, "0"], [-0, "0"], [3.5, "3.5"], [3.7, "3.7"], [0.1 + 0.2, "0.30000000000000004"], [1e21, "1e+21"], [1e-7, "1e-7"],
      [0.000001, "0.000001"], [-1.5e-10, "-1.5e-10"], [2 ** 53 + 2, "9007199254740994"], [Number.MAX_VALUE, "1.7976931348623157e+308"],
      [5e-324, "5e-324"], [123456789012345680000, "123456789012345680000"],
    ];
    for (const [n, text] of cases) expect(jcs(n)).toBe(text);
    expect(jcs({ b: 0.5, a: [1, 2.25] })).toBe('{"a":[1,2.25],"b":0.5}');
  });

  it("refuses values JSON cannot represent", () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(() => jcs({ n })).toThrow(/non-finite/);
    expect(() => jcs([undefined])).toThrow(/no JSON form/);
    expect(() => jcs("x\ud800")).toThrow(/unpaired surrogate/);
    expect(() => jcs({ ["\udc00"]: 1 })).toThrow(/unpaired surrogate/);
  });

  it("omits undefined members and writes no whitespace", () => {
    expect(jcs({ z: null, a: undefined, m: [true, false, "s"] })).toBe('{"m":[true,false,"s"],"z":null}');
  });

  it("narrows to safe integers in integer mode, the registry and bundle digest rule", () => {
    expect(() => jcs({ a: 1.5 }, "integer")).toThrow(/non-integer numbers/);
    expect(() => jcs(2 ** 53, "integer")).toThrow(/non-integer numbers/);
    expect(jcs({ b: 1, a: [true, null, "x"] }, "integer")).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it("agrees with integer mode wherever integer mode accepts", () => {
    const value = { id: "x", n: [0, -1, 42, Number.MAX_SAFE_INTEGER], nested: { "ö": 1, a: "😀" } };
    expect(jcs(value)).toBe(jcs(value, "integer"));
  });

  it("is separate from the request fingerprint serializer", () => {
    // fingerprint.ts canonicalJson is a stored v1 algorithm; it must not change with jcs.
    expect(canonicalJson({ b: 1.5, a: 1 })).toBe('{"a":1,"b":1.5}');
    expect(hasLoneSurrogate("😀")).toBe(false);
    expect(hasLoneSurrogate("\ud83d")).toBe(true);
  });
});
