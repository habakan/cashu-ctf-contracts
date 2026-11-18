import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  conditionId,
  eventIdOf,
  locate,
  occurrenceId,
  type ParseError,
  parse,
  schema,
  stringify,
} from "../src/index.js";

const example = (name: string) => readFileSync(new URL(`examples/${name}.yaml`, import.meta.url), "utf8");
const errorsOf = (text: string): ParseError[] => {
  const result = parse(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
};
const HEX = "9be6fa256a022aafc98f24a71f0e37ab2ac6fe5b208a77a3d429b4b5c59f7ce0";
// Swap one spot and check the error on that line
const base = `version: 1
oracles:
  me: { pubkeys: [${HEX}] }
parties:
  mom: mom@walletofsatoshi.com
events:
  wake:
    oracle: me
    title: Up by 6:00
    every: day
    maturity: "10:00 Asia/Tokyo"
    outcomes: [kept, missed]
contracts:
  - event: wake
    payout: { missed: { mom: 100 sat } }
    settle: lightning
`;
const swap = (from: string, to: string) => {
  if (!base.includes(from)) throw new Error(`not in base: ${from}`);
  return base.replace(from, to);
};

describe("parse", () => {
  it("reads yubikiri promises and fills amounts and defaults", () => {
    const result = parse(example("yubikiri"));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const doc = result.value;
    expect(doc.oracles.me).toEqual({
      pubkeys: ["npub1n0n05ft2qg42ljv0yjn37r3h4v4vdljmyz980g759x6tt3vl0nsqvyu64p"],
      threshold: 1,
    });
    expect(doc.events.wake).toMatchObject({ every: "day", outcomes: ["kept", "missed"] });
    expect(doc.contracts[1]).toEqual({
      event: "steps",
      payout: { missed: { friend: { amount: 14, unit: "sat" }, opensats: { amount: 7, unit: "sat" } } },
      max_per_day: { amount: 210, unit: "sat" },
      settle: "lightning",
    });
    expect(doc.limits.per_day).toEqual({ amount: 500, unit: "sat" });
    expect(doc.markets).toEqual([]);
  });

  it("reads a bitCaster market and fills one outcome collection per outcome", () => {
    const result = parse(example("market"));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.value.markets).toEqual([
      { event: "btc-100k", mint: "https://mint.example", unit: "sat", outcome_collections: ["Yes", "No"] },
    ]);
    expect(result.value.events["btc-100k"]?.outcomes).toEqual(["Yes", "No"]);
    expect(result.value.contracts).toEqual([]);
  });

  it("round-trips through stringify", () => {
    for (const name of ["yubikiri", "market"]) {
      const first = parse(example(name));
      if (!first.ok) throw new Error(name);
      const again = parse(stringify(first.value));
      expect(again).toEqual(first);
    }
  });
});

describe("parse errors", () => {
  const cases: [string, string, number, RegExp][] = [
    ["an unknown key", swap("    settle: lightning", "    settle: lightning\n    memo: x"), 17, /memo/],
    ["a missing version", base.replace("version: 1\n", ""), 1, /version/],
    ["an unknown oracle", swap("oracle: me", "oracle: you"), 8, /you/],
    ["an unknown party", swap("{ mom: 100 sat }", "{ dad: 100 sat }"), 15, /dad/],
    ["an unknown event", swap("- event: wake", "- event: sleep"), 14, /sleep/],
    ["an unknown outcome", swap("payout: { missed:", "payout: { late:"), 15, /late/],
    ["a non-ASCII outcome", swap("[kept, missed]", "[守った, missed]"), 12, /守った/],
    ["outcomes differing only in case", swap("[kept, missed]", "[kept, Kept]"), 12, /Kept/],
    ["an outcome with |", swap("[kept, missed]", "[kept, a|b]"), 12, /a\|b/],
    ["a malformed amount", swap("100 sat", "100 sats"), 15, /100 sats/],
    ["a recurring event's maturity", swap('"10:00 Asia/Tokyo"', "2026-11-18T10:00:00Z"), 11, /maturity/],
    ["a one-off event's maturity", swap("    every: day\n", ""), 10, /maturity/],
    ["a malformed npub", swap(`[${HEX}]`, "[npub1nope]"), 3, /npub1nope/],
    ["a cashu-ctf party without a Cashu key", swap("settle: lightning", "settle: cashu-ctf"), 15, /mom/],
  ];
  for (const [name, text, line, message] of cases)
    it(`rejects ${name} at line ${line}`, () => {
      const [first] = errorsOf(text);
      expect(first?.line).toBe(line);
      expect(first?.message).toMatch(message);
    });

  it("rejects an event in two contracts and a second " * "", () => {
    const twice = `${base}  - event: wake\n    payout: { missed: { mom: 1 sat } }\n    settle: lightning\n`;
    expect(errorsOf(twice)[0]).toMatchObject({ line: 17, message: expect.stringMatching(/wake/) });
    const stars = `${base}  - event: "*"\n    payout: { missed: { mom: 1 sat } }\n    settle: lightning\n  - event: "*"\n    payout: { missed: { mom: 1 sat } }\n    settle: lightning\n`;
    expect(errorsOf(stars)[0]).toMatchObject({ line: 20, message: expect.stringMatching(/\*/) });
  });

  it("rejects max_per_day in another unit and jpy with cashu-ctf", () => {
    const max = swap("    settle: lightning", "    max_per_day: 300 jpy\n    settle: lightning");
    expect(errorsOf(max)[0]).toMatchObject({ line: 16, message: expect.stringMatching(/max_per_day/) });
    const jpy = swap("mom: mom@walletofsatoshi.com", `mom: 02${HEX}`)
      .replace("100 sat", "100 jpy")
      .replace("settle: lightning", "settle: cashu-ctf");
    expect(errorsOf(jpy)[0]).toMatchObject({ line: 15, message: expect.stringMatching(/jpy/) });
  });

  it("returns every problem in line order", () => {
    const text = swap("oracle: me", "oracle: you").replace("{ mom: 100 sat }", "{ dad: 100 sat }");
    expect(errorsOf(text).map((e) => e.line)).toEqual([8, 15]);
  });
});

describe("schema.json", () => {
  const validate = new Ajv({ allErrors: true }).compile(schema);
  it("accepts the examples and rejects malformed shapes", () => {
    expect(validate(parseYaml(example("yubikiri")))).toBe(true);
    expect(validate(parseYaml(example("market")))).toBe(true);
    expect(validate(parseYaml(swap("100 sat", "100 sats")))).toBe(false);
    expect(validate(parseYaml(swap("    settle: lightning", "    settle: lightning\n    memo: x")))).toBe(
      false,
    );
  });
});

describe("NUT-CTF", () => {
  // Expected values computed separately from the spec's formula (BIP-340 tagged hash) with Python's hashlib
  it("conditionId sorts the keys and hashes them with the event id and outcome count", () => {
    expect(conditionId([HEX], occurrenceId("wake", "2026-11-18"), 2)).toBe(
      "6a5189f144de9ce6ffdc4cd44c909626a8608d0d241850e82e90421f7ac12ff8",
    );
    expect(conditionId([HEX, "1f".repeat(32)], "btc-100k", 2)).toBe(
      "a263f09c25d968ff9f5ae69d06014bdf5d674cea372ef3ce4ccb021d4059f509",
    );
  });
});

describe("contracts over several events", () => {
  const two = swap(
    "contracts:",
    `  gym:
    oracle: me
    title: Gym
    every: day
    maturity: "10:00 Asia/Tokyo"
    outcomes: [kept, missed]
contracts:`,
  );
  it("reads a list of events as one contract sharing max_per_day", () => {
    const text = two
      .replace("- event: wake", "- event: [wake, gym]")
      .replace("    settle: lightning", "    max_per_day: 210 sat\n    settle: lightning");
    const result = parse(text);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.value.contracts[0]).toMatchObject({
      event: ["wake", "gym"],
      max_per_day: { amount: 210, unit: "sat" },
    });
    expect(parse(stringify(result.value))).toEqual(result);
  });

  it("rejects " * " in a list and overlapping events with a code and the name", () => {
    expect(errorsOf(two.replace("- event: wake", '- event: [wake, "*"]'))[0]).toMatchObject({
      code: "catch_all_in_list",
      subject: "*",
    });
    const overlap = `${two.replace("- event: wake", "- event: [wake, gym]")}  - event: gym\n    payout: { missed: { mom: 1 sat } }\n    settle: lightning\n`;
    expect(errorsOf(overlap)[0]).toMatchObject({ code: "duplicate_event", subject: "gym", line: 23 });
    expect(errorsOf(swap("{ mom: 100 sat }", "{ dad: 100 sat }"))[0]).toMatchObject({
      code: "unknown_party",
      subject: "dad",
    });
  });
});

describe("locate", () => {
  it("returns the position of a path, or of its closest existing parent", () => {
    expect(locate(base, ["contracts", 0, "settle"])).toEqual({ line: 16, column: 5 });
    expect(locate(base, ["contracts", 0, "nothing"])).toEqual({ line: 14, column: 5 });
  });
});

describe("event ids", () => {
  const named = swap("  wake:\n", "  早起き:\n    id: rtn_wake\n").replace(
    "- event: wake",
    "- event: 早起き",
  );
  it("takes the event id from id rather than the key", () => {
    const result = parse(named);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.value.events.早起き?.id).toBe("rtn_wake");
    expect(eventIdOf(result.value, "早起き")).toBe("rtn_wake");
    expect(eventIdOf(result.value, "wake")).toBe("wake");
    expect(parse(stringify(result.value))).toEqual(result);
  });

  it("rejects two events sharing one id", () => {
    const twice = named.replace(
      "contracts:",
      `  寝坊:
    id: rtn_wake
    oracle: me
    title: Late
    every: day
    maturity: "10:00 Asia/Tokyo"
    outcomes: [kept, missed]
contracts:`,
    );
    expect(errorsOf(twice)[0]).toMatchObject({ code: "duplicate_event_id", subject: "rtn_wake", line: 15 });
  });
});
