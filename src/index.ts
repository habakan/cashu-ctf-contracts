/**
 * Reads and writes cashu-ctf-contracts documents (see SPEC.md).
 * The schema checks the shape; the checks below cover what a schema cannot: references, duplicates, units.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { Ajv, type ErrorObject } from "ajv";
import { isMap, LineCounter, parseDocument, stringify as toYaml } from "yaml";
import schemaJson from "../schema.json" with { type: "json" };

export const schema = schemaJson;

export type Unit = "sat" | "msat" | "jpy";
export interface Amount {
  amount: number;
  unit: Unit;
}
export interface Oracle {
  /** npub or 32-byte x-only hex, as written */
  pubkeys: string[];
  threshold: number;
}
export interface Event {
  /** the event id the oracle announces; defaults to the key */
  id?: string;
  oracle: string;
  title: string;
  description?: string;
  outcomes: string[];
  labels?: Record<string, string>;
  maturity: string;
  every?: string;
  /** how the oracle decides the outcome; its shape is up to the oracle */
  rule?: Record<string, unknown>;
}
export interface Market {
  event: string;
  mint: string;
  unit: "sat" | "msat";
  outcome_collections: string[];
}
export interface Contract {
  /** one event, several events sharing max_per_day, or "*" for events no other contract names */
  event: string | string[];
  payout: Record<string, Record<string, Amount>>;
  max_per_day?: Amount;
  settle: "lightning" | "cashu-ctf";
}
export interface Contracts {
  version: 1;
  oracles: Record<string, Oracle>;
  parties: Record<string, string>;
  events: Record<string, Event>;
  markets: Market[];
  contracts: Contract[];
  limits: { per_day?: Amount };
}

export interface ParseError {
  line: number;
  column: number;
  /** where in the document, such as "contracts.0.payout" */
  path: string;
  code: ErrorCode;
  /** the name or value at fault, for messages in other languages */
  subject: string;
  message: string;
}
export type ErrorCode =
  | "yaml"
  | "shape"
  | "unknown_key"
  | "missing"
  | "invalid_pubkey"
  | "threshold"
  | "unknown_oracle"
  | "duplicate_outcome"
  | "maturity"
  | "unknown_event"
  | "outcome_collection"
  | "duplicate_event"
  | "duplicate_event_id"
  | "catch_all_in_list"
  | "unknown_outcome"
  | "unknown_party"
  | "needs_cashu_key"
  | "cashu_jpy"
  | "max_unit";
export type ParseResult = { ok: true; value: Contracts } | { ok: false; errors: ParseError[] };

type Path = (string | number)[];
type Raw = Omit<Contracts, "markets" | "contracts" | "limits" | "oracles"> & {
  oracles?: Record<string, { pubkeys: string[]; threshold?: number }>;
  parties?: Record<string, string>;
  events?: Record<string, Event>;
  markets?: (Omit<Market, "outcome_collections"> & { outcome_collections?: string[] })[];
  contracts?: (Omit<Contract, "payout" | "max_per_day"> & {
    payout: Record<string, Record<string, string>>;
    max_per_day?: string;
  })[];
  limits?: { per_day?: string };
};

const validate = new Ajv({ allErrors: true }).compile(schema);
const CASHU_KEY = /^0[23][0-9a-f]{64}$/;
// A recurring event is due at a local time; a one-off event at an RFC 3339 instant
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9] [A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const amountOf = (text: string): Amount => {
  const [amount, unit] = text.split(" ");
  return { amount: Number(amount), unit: unit as Unit };
};
const amountText = (a: Amount) => `${a.amount} ${a.unit}`;

/** The 32-byte x-only key of an npub or hex string, or null when it is neither */
export function pubkeyHex(key: string): string | null {
  if (/^[0-9a-f]{64}$/.test(key)) return key;
  try {
    const { prefix, words } = bech32.decode(key as `${string}1${string}`);
    const bytes = bech32.fromWords(words);
    return prefix === "npub" && bytes.length === 32 ? bytesToHex(bytes) : null;
  } catch {
    return null;
  }
}

/** The id the oracle announces for the event at key */
export const eventIdOf = (doc: Contracts, key: string) => doc.events[key]?.id ?? key;

/** Id of one occurrence of a recurring event, by the local date of the period it judges */
export const occurrenceId = (id: string, date: string) => `${id}/${date}`;

/** NUT-CTF condition_id = tagged_hash("Cashu_condition_id", sorted_oracle_pubkeys || event_id || outcome_count) */
export function conditionId(pubkeys: string[], eventId: string, outcomeCount: number): string {
  const keys = pubkeys.map((k) => {
    const hex = pubkeyHex(k);
    if (!hex) throw new Error(`not a public key: ${k}`);
    return hex;
  });
  const tag = sha256(utf8ToBytes("Cashu_condition_id"));
  const msg = concatBytes(...keys.sort().map(hexToBytes), utf8ToBytes(eventId), Uint8Array.of(outcomeCount));
  return bytesToHex(sha256(concatBytes(tag, tag, msg)));
}

interface Problem {
  path: Path;
  code: ErrorCode;
  /** the name or value at fault, for messages in other languages */
  subject: string;
  message: string;
}
const problem = (path: Path, code: ErrorCode, subject: string, message: string): Problem => ({
  path,
  code,
  subject,
  message,
});
const eventsOf = (c: { event: string | string[] }) => (Array.isArray(c.event) ? c.event : [c.event]);

function references(raw: Raw): Problem[] {
  const problems: Problem[] = [];
  const events = raw.events ?? {};
  const parties = raw.parties ?? {};
  for (const [name, oracle] of Object.entries(raw.oracles ?? {})) {
    oracle.pubkeys.forEach((k, i) => {
      if (!pubkeyHex(k))
        problems.push(
          problem(["oracles", name, "pubkeys", i], "invalid_pubkey", k, `not a valid public key: ${k}`),
        );
    });
    if ((oracle.threshold ?? 1) > oracle.pubkeys.length)
      problems.push(
        problem(
          ["oracles", name, "threshold"],
          "threshold",
          name,
          "threshold is larger than the number of keys",
        ),
      );
  }
  const ids = new Map<string, string>();
  for (const [id, event] of Object.entries(events)) {
    const announced = event.id ?? id;
    if (ids.has(announced))
      problems.push(
        problem(
          event.id ? ["events", id, "id"] : ["events", id],
          "duplicate_event_id",
          announced,
          `event id "${announced}" is also used by "${ids.get(announced)}"`,
        ),
      );
    ids.set(announced, id);
    if (!raw.oracles?.[event.oracle])
      problems.push(
        problem(["events", id, "oracle"], "unknown_oracle", event.oracle, `unknown oracle "${event.oracle}"`),
      );
    const seen = new Set<string>();
    event.outcomes.forEach((o, i) => {
      if (seen.has(o.toLowerCase()))
        problems.push(
          problem(
            ["events", id, "outcomes", i],
            "duplicate_outcome",
            o,
            `outcome "${o}" repeats another ignoring case`,
          ),
        );
      seen.add(o.toLowerCase());
    });
    if (!(event.every ? LOCAL_TIME : INSTANT).test(event.maturity))
      problems.push(
        problem(
          ["events", id, "maturity"],
          "maturity",
          event.maturity,
          `maturity "${event.maturity}" must be ${event.every ? 'a local time like "10:00 Asia/Tokyo"' : "an RFC 3339 time"}`,
        ),
      );
  }
  (raw.markets ?? []).forEach((m, i) => {
    const event = events[m.event];
    if (!event) {
      problems.push(problem(["markets", i, "event"], "unknown_event", m.event, `unknown event "${m.event}"`));
      return;
    }
    (m.outcome_collections ?? []).forEach((c, j) => {
      const parts = c.split("|");
      if (parts.some((p) => !event.outcomes.includes(p)) || parts.length >= event.outcomes.length)
        problems.push(
          problem(
            ["markets", i, "outcome_collections", j],
            "outcome_collection",
            c,
            `"${c}" is not a proper subset of the outcomes`,
          ),
        );
    });
  });
  const named = new Set<string>();
  (raw.contracts ?? []).forEach((c, i) => {
    const ids = eventsOf(c);
    const at = (j: number): Path =>
      Array.isArray(c.event) ? ["contracts", i, "event", j] : ["contracts", i, "event"];
    ids.forEach((id, j) => {
      if (named.has(id))
        problems.push(problem(at(j), "duplicate_event", id, `event "${id}" is already in another contract`));
      named.add(id);
      if (id === "*" && ids.length > 1)
        problems.push(problem(at(j), "catch_all_in_list", id, `"*" cannot be listed with other events`));
      else if (id !== "*" && !events[id])
        problems.push(problem(at(j), "unknown_event", id, `unknown event "${id}"`));
    });
    const units = new Set<string>();
    for (const [outcome, pays] of Object.entries(c.payout)) {
      const lacking = ids.find((id) => events[id] && !events[id].outcomes.includes(outcome));
      if (lacking)
        problems.push(
          problem(
            ["contracts", i, "payout", outcome],
            "unknown_outcome",
            outcome,
            `event "${lacking}" has no outcome "${outcome}"`,
          ),
        );
      for (const [party, amount] of Object.entries(pays)) {
        const where: Path = ["contracts", i, "payout", outcome, party];
        units.add(amountOf(amount).unit);
        if (!(party in parties))
          problems.push(problem(where, "unknown_party", party, `unknown party "${party}"`));
        else if (c.settle === "cashu-ctf" && !CASHU_KEY.test(parties[party] as string))
          problems.push(
            problem(
              where,
              "needs_cashu_key",
              party,
              `party "${party}" needs a Cashu key (02.../03...) for cashu-ctf`,
            ),
          );
        if (c.settle === "cashu-ctf" && amountOf(amount).unit === "jpy")
          problems.push(problem(where, "cashu_jpy", amount, "cashu-ctf cannot pay a jpy amount"));
      }
    }
    if (c.max_per_day && (units.size !== 1 || !units.has(amountOf(c.max_per_day).unit)))
      problems.push(
        problem(
          ["contracts", i, "max_per_day"],
          "max_unit",
          c.max_per_day,
          "max_per_day must use the same unit as the payouts",
        ),
      );
  });
  return problems;
}

function schemaProblem(e: ErrorObject): Problem {
  const path: Path = e.instancePath
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (e.keyword === "additionalProperties")
    return problem(
      [...path, e.params.additionalProperty],
      "unknown_key",
      e.params.additionalProperty,
      `unknown key "${e.params.additionalProperty}"`,
    );
  if (e.keyword === "required")
    return problem(path, "missing", e.params.missingProperty, `missing "${e.params.missingProperty}"`);
  const where = path.join(".") || "document";
  const shown = e.keyword === "pattern" || e.keyword === "enum" || e.keyword === "const";
  return problem(
    path,
    "shape",
    shown ? String(e.data) : where,
    `${where} ${e.message}${shown ? ` (got ${JSON.stringify(e.data)})` : ""}`,
  );
}

export function parse(text: string): ParseResult {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length > 0)
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const pos = lines.linePos(e.pos[0]);
        return { line: pos.line, column: pos.col, path: "", code: "yaml", subject: "", message: e.message };
      }),
    };
  const raw = doc.toJS() as Raw;
  const problems = validate(raw)
    ? references(raw)
    : (validate.errors ?? []).map((e) =>
        schemaProblem({ ...e, data: e.data ?? dataAt(raw, e.instancePath) }),
      );
  if (problems.length > 0) {
    const errors = problems.map(({ path, ...rest }) => {
      const pos = lines.linePos(offsetOf(doc, path));
      return { line: pos.line, column: pos.col, path: path.join("."), ...rest };
    });
    return { ok: false, errors: errors.sort((a, b) => a.line - b.line || a.column - b.column) };
  }
  return { ok: true, value: complete(raw) };
}

function dataAt(raw: unknown, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], raw);
}

/** Line and column of the node at path, for applications that add their own checks */
export function locate(text: string, path: (string | number)[]): { line: number; column: number } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const pos = lines.linePos(offsetOf(doc, path));
  return { line: pos.line, column: pos.col };
}

/** Start of the node at path, or of the closest parent that exists */
function offsetOf(doc: ReturnType<typeof parseDocument>, path: Path): number {
  for (let n = path.length; n >= 0; n -= 1) {
    const parent = doc.getIn(path.slice(0, n - 1), true);
    // A key that names the problem (unknown key, unknown party) points at the key itself
    if (n > 0 && isMap(parent)) {
      const pair = parent.items.find((p) => (p.key as { value?: unknown })?.value === path[n - 1]);
      const range = (pair?.key as { range?: [number, number] } | undefined)?.range;
      if (range) return range[0];
    }
    const node = doc.getIn(path.slice(0, n), true) as { range?: [number, number] } | undefined;
    if (node?.range) return node.range[0];
  }
  return 0;
}

function complete(raw: Raw): Contracts {
  const events = raw.events ?? {};
  return {
    version: 1,
    oracles: Object.fromEntries(
      Object.entries(raw.oracles ?? {}).map(([k, o]) => [
        k,
        { pubkeys: o.pubkeys, threshold: o.threshold ?? 1 },
      ]),
    ),
    parties: raw.parties ?? {},
    events,
    markets: (raw.markets ?? []).map((m) => ({
      ...m,
      outcome_collections: m.outcome_collections ?? events[m.event]?.outcomes ?? [],
    })),
    contracts: (raw.contracts ?? []).map((c) => ({
      event: c.event,
      payout: Object.fromEntries(
        Object.entries(c.payout).map(([o, pays]) => [
          o,
          Object.fromEntries(Object.entries(pays).map(([p, a]) => [p, amountOf(a)])),
        ]),
      ),
      ...(c.max_per_day ? { max_per_day: amountOf(c.max_per_day) } : {}),
      settle: c.settle,
    })),
    limits: raw.limits?.per_day ? { per_day: amountOf(raw.limits.per_day) } : {},
  };
}

/** The plain document that matches schema.json. Its JSON is also valid input to parse, since YAML 1.2 reads JSON. */
export function toDocument(value: Contracts): Record<string, unknown> {
  return {
    ...value,
    contracts: value.contracts.map((c) => ({
      event: c.event,
      payout: Object.fromEntries(
        Object.entries(c.payout).map(([o, pays]) => [
          o,
          Object.fromEntries(Object.entries(pays).map(([p, a]) => [p, amountText(a)])),
        ]),
      ),
      ...(c.max_per_day ? { max_per_day: amountText(c.max_per_day) } : {}),
      settle: c.settle,
    })),
    limits: value.limits.per_day ? { per_day: amountText(value.limits.per_day) } : {},
  };
}

export const stringify = (value: Contracts): string => toYaml(toDocument(value));
