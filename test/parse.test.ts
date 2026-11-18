import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  conditionId,
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
// 1 か所だけ差し替えて、その行のエラーを見る
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
  it("yubikiri の約束を読み、額と既定の値を埋める", () => {
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

  it("bitCaster のマーケットを読み、結果の組を結果ごとに埋める", () => {
    const result = parse(example("market"));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.value.markets).toEqual([
      { event: "btc-100k", mint: "https://mint.example", unit: "sat", outcome_collections: ["Yes", "No"] },
    ]);
    expect(result.value.events["btc-100k"]?.outcomes).toEqual(["Yes", "No"]);
    expect(result.value.contracts).toEqual([]);
  });

  it("stringify してから読み戻すと同じ値になる", () => {
    for (const name of ["yubikiri", "market"]) {
      const first = parse(example(name));
      if (!first.ok) throw new Error(name);
      const again = parse(stringify(first.value));
      expect(again).toEqual(first);
    }
  });
});

describe("parse のエラー", () => {
  const cases: [string, string, number, RegExp][] = [
    ["知らないキー", swap("    settle: lightning", "    settle: lightning\n    memo: x"), 17, /memo/],
    ["version が無い", base.replace("version: 1\n", ""), 1, /version/],
    ["存在しないオラクル", swap("oracle: me", "oracle: you"), 8, /you/],
    ["存在しない相手", swap("{ mom: 100 sat }", "{ dad: 100 sat }"), 15, /dad/],
    ["存在しない事象", swap("- event: wake", "- event: sleep"), 14, /sleep/],
    ["存在しない結果", swap("payout: { missed:", "payout: { late:"), 15, /late/],
    ["半角英数字でない結果", swap("[kept, missed]", "[守った, missed]"), 12, /守った/],
    ["大文字と小文字だけ違う結果", swap("[kept, missed]", "[kept, Kept]"), 12, /Kept/],
    ["| を含む結果", swap("[kept, missed]", "[kept, a|b]"), 12, /a\|b/],
    ["額の書き方", swap("100 sat", "100 sats"), 15, /100 sats/],
    ["毎日の事象の締め", swap('"10:00 Asia/Tokyo"', "2026-11-18T10:00:00Z"), 11, /maturity/],
    ["1 回きりの事象の締め", swap("    every: day\n", ""), 10, /maturity/],
    ["形の合わない npub", swap(`[${HEX}]`, "[npub1nope]"), 3, /npub1nope/],
    ["cashu-ctf に Cashu の鍵が無い相手", swap("settle: lightning", "settle: cashu-ctf"), 15, /mom/],
  ];
  for (const [name, text, line, message] of cases)
    it(`${name} は ${line} 行目で断る`, () => {
      const [first] = errorsOf(text);
      expect(first?.line).toBe(line);
      expect(first?.message).toMatch(message);
    });

  it("同じ事象が 2 つの契約に入るときと、* が 2 つあるときは断る", () => {
    const twice = `${base}  - event: wake\n    payout: { missed: { mom: 1 sat } }\n    settle: lightning\n`;
    expect(errorsOf(twice)[0]).toMatchObject({ line: 17, message: expect.stringMatching(/wake/) });
    const stars = `${base}  - event: "*"\n    payout: { missed: { mom: 1 sat } }\n    settle: lightning\n  - event: "*"\n    payout: { missed: { mom: 1 sat } }\n    settle: lightning\n`;
    expect(errorsOf(stars)[0]).toMatchObject({ line: 20, message: expect.stringMatching(/\*/) });
  });

  it("max_per_day の単位が配分と違うときと、cashu-ctf で jpy を使うときは断る", () => {
    const max = swap("    settle: lightning", "    max_per_day: 300 jpy\n    settle: lightning");
    expect(errorsOf(max)[0]).toMatchObject({ line: 16, message: expect.stringMatching(/max_per_day/) });
    const jpy = swap("mom: mom@walletofsatoshi.com", `mom: 02${HEX}`)
      .replace("100 sat", "100 jpy")
      .replace("settle: lightning", "settle: cashu-ctf");
    expect(errorsOf(jpy)[0]).toMatchObject({ line: 15, message: expect.stringMatching(/jpy/) });
  });

  it("間違いが複数あれば全部を行の順に返す", () => {
    const text = swap("oracle: me", "oracle: you").replace("{ mom: 100 sat }", "{ dad: 100 sat }");
    expect(errorsOf(text).map((e) => e.line)).toEqual([8, 15]);
  });
});

describe("schema.json", () => {
  const validate = new Ajv({ allErrors: true }).compile(schema);
  it("正しい例を通し、形の間違いを断る", () => {
    expect(validate(parseYaml(example("yubikiri")))).toBe(true);
    expect(validate(parseYaml(example("market")))).toBe(true);
    expect(validate(parseYaml(swap("100 sat", "100 sats")))).toBe(false);
    expect(validate(parseYaml(swap("    settle: lightning", "    settle: lightning\n    memo: x")))).toBe(
      false,
    );
  });
});

describe("NUT-CTF", () => {
  // 期待値は仕様の式 (BIP-340 の tagged hash) を Python の hashlib で別に計算したもの
  it("conditionId は鍵を並べ替え、事象の id と結果の数から計算する", () => {
    expect(conditionId([HEX], occurrenceId("wake", "2026-11-18"), 2)).toBe(
      "6a5189f144de9ce6ffdc4cd44c909626a8608d0d241850e82e90421f7ac12ff8",
    );
    expect(conditionId([HEX, "1f".repeat(32)], "btc-100k", 2)).toBe(
      "a263f09c25d968ff9f5ae69d06014bdf5d674cea372ef3ce4ccb021d4059f509",
    );
  });
});

describe("複数の事象をまとめた契約", () => {
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
  it("event に一覧を書くと 1 日の上限を共有する 1 つの契約として読む", () => {
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

  it("一覧の中の * と、ほかの契約と重なる事象は、種類のコードと名前つきで断る", () => {
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
  it("パスの位置を返し、無いパスは近い親の位置を返す", () => {
    expect(locate(base, ["contracts", 0, "settle"])).toEqual({ line: 16, column: 5 });
    expect(locate(base, ["contracts", 0, "nothing"])).toEqual({ line: 14, column: 5 });
  });
});
