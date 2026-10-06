import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { SplitBar, segmentsOf } from './SplitBar';
import { encodeSplit, formatPercent, MAX_MEMBERS, MEMBER_COLORS, SplitConfig, TOTAL_BPS, TREASURY_COLOR, validate } from '../lib/split';

interface Row {
  name: string;
  wallet: string;
  percent: string;
  staked: boolean;
}

const toBps = (percent: string): number => {
  const value = Number(percent.replace(',', '.'));
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};
const fromBps = (bps: number): string => (bps / 100).toFixed(2).replace(/\.?0+$/, '');

export function Create() {
  const { publicKey } = useWallet();
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>([
    { name: '', wallet: '', percent: '50', staked: false },
    { name: '', wallet: '', percent: '50', staked: false },
  ]);
  const [useTreasury, setUseTreasury] = useState(false);
  const [treasuryWallet, setTreasuryWallet] = useState('');
  const [treasuryPercent, setTreasuryPercent] = useState('20');
  const [showProblems, setShowProblems] = useState(false);

  const config: SplitConfig = useMemo(
    () => ({
      v: 1,
      name,
      members: rows.map((r) => ({ name: r.name, wallet: r.wallet.trim(), bps: toBps(r.percent), ...(r.staked ? { staked: true } : {}) })),
      treasury: useTreasury ? { wallet: treasuryWallet.trim(), bps: toBps(treasuryPercent) } : undefined,
    }),
    [name, rows, useTreasury, treasuryWallet, treasuryPercent],
  );
  const problems = useMemo(() => validate(config), [config]);
  const assigned = config.members.reduce((s, m) => s + m.bps, 0) + (config.treasury?.bps ?? 0);

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /** Shares the non-treasury part evenly, giving any leftover hundredth to the first teammate. */
  const splitEvenly = (count = rows.length, treasuryOn = useTreasury, treasuryPct = treasuryPercent) => {
    const pool = TOTAL_BPS - (treasuryOn ? toBps(treasuryPct) : 0);
    if (pool <= 0 || count === 0) return;
    const each = Math.floor(pool / count);
    setRows((rs) => rs.slice(0, count).map((r, i) => ({ ...r, percent: fromBps(each + (i === 0 ? pool - each * count : 0)) })));
  };

  const addRow = () => {
    setRows((rs) => [...rs, { name: '', wallet: '', percent: '0', staked: false }]);
    setTimeout(() => splitEvenly(rows.length + 1), 0);
  };
  const removeRow = (i: number) => {
    setRows((rs) => rs.filter((_, j) => j !== i));
    setTimeout(() => splitEvenly(rows.length - 1), 0);
  };
  const toggleTreasury = (on: boolean) => {
    setUseTreasury(on);
    splitEvenly(rows.length, on);
  };

  const create = () => {
    if (problems.length) {
      setShowProblems(true);
      return;
    }
    window.location.hash = `#/s/${encodeSplit(config)}`;
    window.scrollTo(0, 0);
  };

  return (
    <div className="create">
      <section className="hero">
        <h1>One prize. Every teammate paid at the same moment.</h1>
        <p className="lede">
          Agree on shares before you win. Whoever pays sends one transaction and Solana delivers each share straight to its
          owner. Nobody holds the whole prize, not even for a second.
        </p>
        <SplitBar segments={segmentsOf(config.members, config.treasury?.bps)} />
      </section>

      <section className="card">
        <label className="field">
          <span>Split name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team Nova, Prague Build Station" maxLength={60} />
        </label>

        <div className="rows-head">
          <h2>Teammates</h2>
          <button type="button" className="link" onClick={() => splitEvenly()}>
            Split evenly
          </button>
        </div>

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
                  placeholder="Solana wallet address"
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
                  onChange={(e) => update(i, { percent: e.target.value.replace(/[^\d.,]/g, '') })}
                />
                <span>%</span>
              </div>
              <button
                type="button"
                className={`mode${row.staked ? ' is-on' : ''}`}
                aria-pressed={row.staked}
                title="Stake this share with Marinade on arrival. It lands as mSOL and earns staking rewards."
                onClick={() => update(i, { staked: !row.staked })}
              >
                {row.staked ? 'Staked' : 'Stake it'}
              </button>
              <button
                type="button"
                className="icon"
                onClick={() => removeRow(i)}
                disabled={rows.length <= 1}
                aria-label={`Remove teammate ${i + 1}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <p className="hint stake-hint">
          Turn on <strong>Stake it</strong> and that share is staked with Marinade the moment the prize is paid. It arrives as
          mSOL and earns staking rewards from the first second.
        </p>

        {rows.length < MAX_MEMBERS && (
          <button type="button" className="btn btn-ghost" onClick={addRow}>
            Add teammate
          </button>
        )}

        <div className={`treasury${useTreasury ? ' is-on' : ''}`}>
          <label className="check">
            <input type="checkbox" checked={useTreasury} onChange={(e) => toggleTreasury(e.target.checked)} />
            <span>
              <strong>Keep a share for the team treasury</strong>
              <small>
                Money for building after the hackathon. It is staked with Marinade the moment it arrives, so it earns staking
                rewards as mSOL until the team spends it.
              </small>
            </span>
          </label>
          {useTreasury && (
            <div className="row row-treasury">
              <span className="dot" style={{ background: TREASURY_COLOR }} aria-hidden="true" />
              <div className="row-wallet">
                <input
                  aria-label="Treasury wallet address"
                  value={treasuryWallet}
                  onChange={(e) => setTreasuryWallet(e.target.value)}
                  placeholder="Treasury wallet address (a shared or multisig wallet)"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </div>
              <div className="row-share">
                <input
                  aria-label="Treasury share in percent"
                  inputMode="decimal"
                  value={treasuryPercent}
                  onChange={(e) => setTreasuryPercent(e.target.value.replace(/[^\d.,]/g, ''))}
                  onBlur={() => splitEvenly()}
                />
                <span>%</span>
              </div>
            </div>
          )}
        </div>

        <div className="create-foot">
          <p className={`total${assigned === TOTAL_BPS ? ' is-ok' : ''}`}>
            {assigned === TOTAL_BPS ? 'Shares add up to 100%' : `Shares add up to ${formatPercent(assigned)} of 100%`}
          </p>
          <button type="button" className="btn btn-primary" onClick={create}>
            Create split link
          </button>
        </div>

        {showProblems && problems.length > 0 && (
          <ul className="problems" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="how">
        <div>
          <h3>Agree</h3>
          <p>Each teammate signs the shares with their own wallet. Change one number and it becomes a different split.</p>
        </div>
        <div>
          <h3>Share one link</h3>
          <p>Give it to the organiser, sponsor or client. They need nothing but a wallet.</p>
        </div>
        <div>
          <h3>Get paid together</h3>
          <p>One transaction pays everyone or no one. Every payout is public and checkable.</p>
        </div>
      </section>
    </div>
  );
}
