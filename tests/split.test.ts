import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { allocate, decodeSplit, encodeSplit, formatSol, parseSol, SplitConfig, splitReference, validate } from '../src/lib/split';

const w = () => Keypair.generate().publicKey.toBase58();
const base = (): SplitConfig => ({
  v: 1,
  name: 'Team Žluťoučký 🚀',
  members: [
    { name: 'Ivan', wallet: w(), bps: 4000 },
    { name: 'Yana', wallet: w(), bps: 4000 },
  ],
  treasury: { wallet: w(), bps: 2000 },
});

describe('split', () => {
  it('survives a round trip through the link, including non-ASCII names', () => {
    const config = base();
    const decoded = decodeSplit(encodeSplit(config));
    expect(decoded).toEqual(config);
    expect(splitReference(decoded!).equals(splitReference(config))).toBe(true);
  });

  it('keeps the staked choice in the link and makes it part of the agreed terms', () => {
    const plain = base();
    const staked = { ...plain, members: [{ ...plain.members[0], staked: true }, plain.members[1]] };
    expect(decodeSplit(encodeSplit(staked))!.members[0].staked).toBe(true);
    expect(decodeSplit(encodeSplit(staked))!.members[1].staked).toBeUndefined();
    expect(splitReference(staked).equals(splitReference(plain))).toBe(false);
  });

  it('changes the reference when any share changes', () => {
    const a = base();
    const b = { ...a, members: [{ ...a.members[0], bps: 4100 }, { ...a.members[1], bps: 3900 }] };
    expect(splitReference(a).equals(splitReference(b))).toBe(false);
  });

  it('rejects tampered or broken links', () => {
    expect(decodeSplit('not-a-split')).toBeNull();
    const bad = base();
    bad.members[0].bps = 5000; // now adds up to 110%
    expect(decodeSplit(encodeSplit(bad))).toBeNull();
  });

  it('reports shares that do not add up, bad wallets and duplicates', () => {
    const c = base();
    c.members[1].wallet = c.members[0].wallet;
    c.treasury = undefined;
    const problems = validate(c).join(' ');
    expect(problems).toMatch(/already in the split/);
    expect(problems).toMatch(/80%/);
    c.members[0].wallet = 'hello';
    expect(validate(c).join(' ')).toMatch(/valid Solana wallet/);
  });

  it('never loses or invents a lamport', () => {
    const thirds: SplitConfig = {
      v: 1,
      name: 't',
      members: [
        { name: 'a', wallet: w(), bps: 3333 },
        { name: 'b', wallet: w(), bps: 3334 },
        { name: 'c', wallet: w(), bps: 3333 },
      ],
    };
    for (const total of [1n, 7n, 999n, 1_000_000_001n, 123_456_789_123n]) {
      for (const config of [thirds, base()]) {
        const a = allocate(config, total);
        expect(a.members.reduce((x, y) => x + y, 0n) + a.treasury).toBe(total);
        a.members.forEach((m) => expect(m >= 0n).toBe(true));
      }
    }
    expect(allocate(base(), 10_000_000_000n)).toEqual({ members: [4_000_000_000n, 4_000_000_000n], treasury: 2_000_000_000n });
  });

  it('parses and formats SOL without floating point', () => {
    expect(parseSol('1.5')).toBe(1_500_000_000n);
    expect(parseSol('0,25')).toBe(250_000_000n);
    expect(parseSol('.000000001')).toBe(1n);
    expect(parseSol('abc')).toBeNull();
    expect(parseSol('')).toBeNull();
    expect(parseSol('1.0000000001')).toBeNull();
    expect(formatSol(1_500_000_000n)).toBe('1.5');
    expect(formatSol(4_000_000_000n)).toBe('4');
    expect(formatSol(1n)).toBe('0.000000001');
    expect(formatSol(1234_000_000_000n)).toBe('1,234');
  });
});
