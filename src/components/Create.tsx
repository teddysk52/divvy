import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { SplitBar, segmentsOf } from './SplitBar';
import { IconPay, IconShares, IconSign } from './Icons';
import { encodeSplit, MAX_MEMBERS, MEMBER_COLORS, SplitConfig, TOTAL_BPS, TREASURY_COLOR, validate } from '../lib/split';

interface Row {
  name: string;
  wallet: string;
  percent: string;
  staked: boolean;
}

export const toBps = (percent: string): number => {
  const value = Number(percent.replace(',', '.'));
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};
export const fromBps = (bps: number): string => (bps / 100).toFixed(2).replace(/\.?0+$/, '');

/**
 * Keeps shares at exactly 100%. One share is set to `wanted`; the difference is
 * taken from shares the person has not set by hand yet (`locked` lists the ones
 * they have), in proportion to their size. If every other share was set by hand,
 * all of them adjust. Every share keeps at least 1%. Exported for tests.
 */
export function rebalance(current: number[], edited: number, wanted: number, locked: number[] = []): number[] {
  const others = current.map((_, i) => i).filter((i) => i !== edited);
  if (others.length === 0) return [TOTAL_BPS];
  const unlocked = others.filter((i) => !locked.includes(i));
  const free = unlocked.length ? unlocked : others;
  const fixed = others.filter((i) => !free.includes(i)).reduce((sum, i) => sum + current[i], 0);
  const floor = 100; // 1%
  const value = Math.min(Math.max(Math.round(wanted) || 0, floor), TOTAL_BPS - fixed - floor * free.length);
  const pool = TOTAL_BPS - fixed - value;
  const spare = pool - floor * free.length;
  const weights = free.map((i) => Math.max(current[i] - floor, 0));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const next = [...current];
  next[edited] = value;
  let given = 0;
  free.forEach((i, k) => {
    const extra = weightSum > 0 ? Math.floor((spare * weights[k]) / weightSum) : Math.floor(spare / free.length);
    next[i] = floor + extra;
    given += next[i];
  });
  next[free[0]] += pool - given; // rounding leftovers
  return next;
}

function evenly(count: number, pool: number): number[] {
  const each = Math.floor(pool / count);
  return Array.from({ length: count }, (_, i) => each + (i === 0 ? pool - each * count : 0));
}

export function Create() {
  const { publicKey } = useWallet();
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>([
    { name: '', wallet: '', percent: '50', staked: false },
    { name: '', wallet: '', percent: '50', staked: false },
  ]);
  const [treasury, setTreasury] = useState<{ wallet: string; percent: string } | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  /** Shares the person typed themselves; these are the last to be adjusted. */
  const [touched, setTouched] = useState<number[]>([]);

  const config: SplitConfig = useMemo(
    () => ({
      v: 1,
      name,
      members: rows.map((r) => ({ name: r.name, wallet: r.wallet.trim(), bps: toBps(r.percent), ...(r.staked ? { staked: true } : {}) })),
      treasury: treasury ? { wallet: treasury.wallet.trim(), bps: toBps(treasury.percent) } : undefined,
    }),
    [name, rows, treasury],
  );
  const problems = useMemo(() => validate(config), [config]);

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /** Applies a full list of shares: teammates first, treasury last when present. */
  const apply = (bps: number[], keepRaw?: { index: number; raw: string }) => {
    setRows((rs) => rs.map((r, i) => ({ ...r, percent: keepRaw?.index === i ? keepRaw.raw : fromBps(bps[i]) })));
    if (treasury) setTreasury((t) => (t ? { ...t, percent: keepRaw?.index === rows.length ? keepRaw.raw : fromBps(bps[rows.length]) } : t));
  };
  const currentBps = () => [...rows.map((r) => toBps(r.percent)), ...(treasury ? [toBps(treasury.percent)] : [])];

  /** While typing, the edited box keeps the raw text and the rest follow so the total stays 100%. */
  const editShare = (index: number, raw: string) => {
    const clean = raw.replace(/[^\d.,]/g, '');
    const total = rows.length + (treasury ? 1 : 0);
    // Once every share has been set by hand, start over so there is always one that can move.
    const locked = touched.filter((i) => i !== index).length >= total - 1 ? [] : touched.filter((i) => i !== index);
    setTouched([...locked, index]);
    apply(rebalance(currentBps(), index, toBps(clean), locked), { index, raw: clean });
  };
  /** On leaving the box, show the value that is actually in effect. */
  const settleShare = (index: number) =>
    apply(rebalance(currentBps(), index, currentBps()[index], touched.filter((i) => i !== index)));

  const resetEvenly = (count: number, treasuryBps: number) => {
    setTouched([]);
    const shares = evenly(count, TOTAL_BPS - treasuryBps);
    setRows((rs) => {
      const list = rs.slice(0, count);
      while (list.length < count) list.push({ name: '', wallet: '', percent: '0', staked: false });
      return list.map((r, i) => ({ ...r, percent: fromBps(shares[i]) }));
    });
  };

  const addRow = () => resetEvenly(rows.length + 1, treasury ? toBps(treasury.percent) : 0);
  const removeRow = (i: number) => {
    setTouched([]);
    const kept = rows.filter((_, j) => j !== i);
    const shares = evenly(kept.length, TOTAL_BPS - (treasury ? toBps(treasury.percent) : 0));
    setRows(kept.map((r, k) => ({ ...r, percent: fromBps(shares[k]) })));
  };
  const addTreasury = () => {
    setTreasury({ wallet: '', percent: '20' });
    resetEvenly(rows.length, 2000);
  };
  const removeTreasury = () => {
    setTreasury(null);
    resetEvenly(rows.length, 0);
  };

  const create = () => {
    if (problems.length) return setShowProblems(true);
    window.location.hash = `#/s/${encodeSplit(config)}`;
    window.scrollTo(0, 0);
  };

  return (
    <div className="create">
      <section className="hero">
        <h1>Split any prize in one transaction.</h1>
        <p className="lede">Set the shares once. When the prize is paid, everyone gets theirs at the same second.</p>
        <ol className="steps">
          <li>
            <IconShares />
            <span>Set shares</span>
          </li>
          <li>
            <IconSign />
            <span>Team signs</span>
          </li>
          <li>
            <IconPay />
            <span>One payment, split</span>
          </li>
        </ol>
      </section>

      <section className="card">
        <SplitBar segments={segmentsOf(config.members, config.treasury?.bps)} />

        <input
          className="title-input"
          aria-label="Split name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this split, e.g. Team Nova"
          maxLength={60}
        />

        <ul className="rows">
          {rows.map((row, i) => (
            <li className="row" key={i}>
              <span className="dot" style={{ background: MEMBER_COLORS[i % MEMBER_COLORS.length] }} aria-hidden="true" />
              <input
                className="row-name"
                aria-label={`Teammate ${i + 1} name`}
                value={row.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="Name"
                maxLength={24}
              />
              <div className="row-wallet">
                <input
                  aria-label={`Teammate ${i + 1} wallet address`}
                  value={row.wallet}
                  onChange={(e) => update(i, { wallet: e.target.value })}
                  placeholder="Wallet address"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                {publicKey && !row.wallet && !rows.some((r) => r.wallet.trim() === publicKey.toBase58()) && (
                  <button type="button" className="link" onClick={() => update(i, { wallet: publicKey.toBase58() })}>
                    Use mine
                  </button>
                )}
              </div>
              <div className="row-share">
                <input
                  aria-label={`Teammate ${i + 1} share in percent`}
                  inputMode="decimal"
                  value={row.percent}
                  onChange={(e) => editShare(i, e.target.value)}
                  onBlur={() => settleShare(i)}
                  disabled={rows.length === 1 && !treasury}
                />
                <span>%</span>
              </div>
              <button
                type="button"
                className={`mode${row.staked ? ' is-on' : ''}`}
                aria-pressed={row.staked}
                aria-label={`Stake teammate ${i + 1} share with Marinade`}
                title="Receive this share already staked with Marinade, as mSOL"
                onClick={() => update(i, { staked: !row.staked })}
              >
                <i aria-hidden="true" />
                Stake
              </button>
              <button type="button" className="icon" onClick={() => removeRow(i)} disabled={rows.length <= 1} aria-label={`Remove teammate ${i + 1}`}>
                ×
              </button>
            </li>
          ))}

          {treasury && (
            <li className="row row-treasury">
              <span className="dot" style={{ background: TREASURY_COLOR }} aria-hidden="true" />
              <span className="row-name row-fixed">Treasury</span>
              <div className="row-wallet">
                <input
                  aria-label="Treasury wallet address"
                  value={treasury.wallet}
                  onChange={(e) => setTreasury({ ...treasury, wallet: e.target.value })}
                  placeholder="Team wallet address"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </div>
              <div className="row-share">
                <input
                  aria-label="Treasury share in percent"
                  inputMode="decimal"
                  value={treasury.percent}
                  onChange={(e) => editShare(rows.length, e.target.value)}
                  onBlur={() => settleShare(rows.length)}
                />
                <span>%</span>
              </div>
              <span className="mode is-on is-locked" title="The treasury share is always staked with Marinade">
                <i aria-hidden="true" />
                Stake
              </span>
              <button type="button" className="icon" onClick={removeTreasury} aria-label="Remove treasury">
                ×
              </button>
            </li>
          )}
        </ul>

        <div className="adders">
          {rows.length < MAX_MEMBERS && (
            <button type="button" className="btn btn-ghost" onClick={addRow}>
              + Teammate
            </button>
          )}
          {!treasury && (
            <button type="button" className="btn btn-ghost" onClick={addTreasury}>
              + Team treasury
            </button>
          )}
        </div>

        {(rows.some((r) => r.staked) || treasury) && (
          <p className="stake-note">
            <i aria-hidden="true" />
            Staked shares go through Marinade and arrive as mSOL, earning rewards from the first second.
          </p>
        )}

        <button type="button" className="btn btn-primary btn-big" onClick={create}>
          Create split link
        </button>

        {showProblems && problems.length > 0 && (
          <ul className="problems" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
