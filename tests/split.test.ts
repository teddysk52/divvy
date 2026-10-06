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

import { rebalance } from '../src/components/Create';

describe('share editing', () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('always totals exactly 100% whatever is typed', () => {
    const cases: [number[], number, number][] = [
      [[5000, 5000], 0, 7000],
      [[3334, 3333, 3333], 0, 5000], // the reported case: 50 / 33.33 / 33.33
      [[3334, 3333, 3333], 1, 99999],
      [[3334, 3333, 3333], 2, 0],
      [[4000, 4000, 2000], 2, 3550],
      [[1250, 1250, 1250, 1250, 1250, 1250, 1250, 1250], 3, 9000],
      [[10000], 0, 40],
      [[100, 9900], 1, 1],
    ];
    for (const [current, index, wanted] of cases) {
      const next = rebalance(current, index, wanted);
      expect(sum(next)).toBe(10000);
      next.forEach((v) => expect(v).toBeGreaterThanOrEqual(100));
    }
  });

  it('gives the edited share what was asked and scales the rest in proportion', () => {
    expect(rebalance([3334, 3333, 3333], 0, 5000)).toEqual([5000, 2500, 2500]);
    expect(rebalance([4000, 4000, 2000], 0, 6000)).toEqual([6000, 2656, 1344]);
    expect(rebalance([5000, 5000], 0, 99999)).toEqual([9900, 100]);
  });

  it('leaves shares the person already set alone when another one can absorb the change', () => {
    // Set teammate 1 to 40, then teammate 2 to 40: only the treasury moves.
    const first = rebalance([9800, 100, 100], 0, 4000);
    const second = rebalance(first, 1, 4000, [0]);
    expect(second).toEqual([4000, 4000, 2000]);
    // A locked share caps how far another can grow.
    expect(rebalance([4000, 4000, 2000], 1, 9000, [0])).toEqual([4000, 5900, 100]);
  });
});
