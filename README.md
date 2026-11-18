# cashu-ctf-contracts

A small YAML format for oracle-settled bets and commitments on bitcoin.

One file describes who the oracle is, which events it will attest, and what happens for each outcome.
The same event can be traded as a market (outcome tokens under [NUT-CTF](https://github.com/cashubtc/nuts/pull/337)),
or settled between parties as a contract (pay a friend over Lightning when you miss a promise, or lock the payout as a conditional token at a mint).

```yaml
version: 1
oracles:
  me: { pubkeys: [npub1...] }
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
```

Status: draft. See [SPEC.md](SPEC.md). The first consumer is [yubikiri](https://github.com/habakan/yubikiri).
