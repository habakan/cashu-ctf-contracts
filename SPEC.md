# cashu-ctf-contracts v1 (draft)

## Terms

- **Oracle**: a set of keys that attests which outcome of an event happened, with a threshold.
- **Event**: a question with a fixed list of outcomes and a maturity time. One event maps to one DLC oracle announcement and, when traded or locked at a mint, one NUT-CTF condition.
- **Market**: outcome tokens of an event, traded freely before maturity (for example on bitCaster).
- **Contract**: a payout table between named parties, settled after the oracle attests.

## File

A document is YAML (or the equivalent JSON) with these top-level keys.
Unknown keys are errors, so typos do not silently change a payout.

```yaml
version: 1          # required
oracles: {}         # name -> Oracle
parties: {}         # name -> address
events: {}          # id -> Event
markets: []         # Market
contracts: []       # Contract
limits: {}          # Limits
```

### Oracle

```yaml
oracles:
  judge:
    pubkeys: [npub1..., npub1...]   # npub or 32-byte x-only hex
    threshold: 2                    # default 1
```

### Party

A name mapped to where value goes: a Lightning address, an npub (zap to its lud16),
a Spark or Ark address, or a Cashu P2PK key (`02...`/`03...`, NUT-11) for `cashu-ctf`.

### Event

```yaml
events:
  btc-100k:
    oracle: judge
    title: BTC above $100k at the end of 2026?
    description: |              # Markdown. This is the resolution criteria
      Resolves Yes if ...
    outcomes: [Yes, No]          # ASCII [A-Za-z0-9_-], 1-191 chars, unique ignoring case
    labels: { Yes: はい }        # optional display names
    maturity: 2026-12-31T00:00:00Z
```

Outcome ids are restricted to ASCII so that they survive NUT-CTF outcome collections (`|`-joined, `*` reserved) and bitCaster's naming rule.

A recurring event adds `every` and gives `maturity` as a local time:

```yaml
  wake:
    oracle: judge
    title: Up by 6:00
    every: day                   # day | week | an RFC 5545 RRULE
    maturity: "10:00 Asia/Tokyo"
    outcomes: [kept, missed]
```

Each occurrence is its own event with id `<id>/<YYYY-MM-DD>` (the local date of the period it judges).

### Market

```yaml
markets:
  - event: btc-100k
    mint: https://mint.example
    unit: sat
    outcome_collections: [Yes, No]   # default: one per outcome
```

Maps to `POST /v1/conditions` of NUT-CTF: `announcements` from the oracle, `threshold`, `collateral: unit`, `outcome_collections`.
Pricing, liquidity and order types belong to the venue, not to this file.

### Contract

```yaml
contracts:
  - event: wake
    payout:
      missed: { mom: 100 sat }
    max_per_day: 210 sat           # optional, recurring events only
    settle: lightning
  - event: "*"                     # catch-all for events no other contract names
    payout:
      missed: { opensats: 50 jpy }
    settle: lightning
```

- `payout` maps an outcome to `{party: amount}`. Outcomes not listed pay nothing.
- `settle`:
  - `lightning`: after the attestation, the payer's wallet pays each party. Works with any wallet; nothing is locked in advance, so it relies on the payer's software running.
  - `cashu-ctf`: before maturity, the payer splits collateral into outcome tokens at a NUT-CTF mint and hands each party the tokens of the outcomes that pay them (P2PK-locked to the party's key). The mint enforces the payout; the payer must lock the funds and trust the mint.
- A `jpy` amount converts at the BTC/JPY rate at settlement time and is only allowed with `lightning`.

### Limits

```yaml
limits:
  per_day: 500 sat     # cap on all contracts' payouts in one day, scaled down proportionally
```

### Amounts

`<integer> sat`, `<integer> msat` or `<integer> jpy`.

## Validation

Documents are read as YAML 1.2, so `Yes`, `No` and `2026-12-31T00:00:00Z` stay strings.
A reader first checks the shape against [schema.json](schema.json), then, once the shape is valid, the rules below.
It reports every problem it finds with its line, when:

- a reference (oracle, party, event, outcome) does not exist;
- an event is named by two contracts, or `"*"` appears twice;
- `max_per_day` uses a different unit than the payouts;
- an outcome id breaks the ASCII rule;
- `settle: cashu-ctf` pays a party without a Cashu key, or uses `jpy`.

## Mapping to NUT-CTF

- `condition_id = tagged_hash("Cashu_condition_id", sorted_oracle_pubkeys || event_id || outcome_count)`, where `event_id` is the event id above (with the date suffix for recurring events).
- The oracle publishes DLC announcements (nonces committed) before maturity and attestations after. Nostr transport (NIP-88, kinds 88/89) is recommended.

## Out of scope for v1

- Nested or combinatorial conditions. NUT-CTF resolves root-level conditions only. A combination can still be written as one event whose outcomes are the combinations (`both`, `btc_only`, ...), if the oracle attests that event.
- Numeric events (NUT-CTF-numeric). Planned once the spec settles.
- Bilateral DLCs on-chain or in channels.

## Open questions

- Should a recurring event announce each day separately, or announce a batch of days at once to save registration fees?
- What should a contract do when the oracle never attests (refund to payer after a timeout?).
