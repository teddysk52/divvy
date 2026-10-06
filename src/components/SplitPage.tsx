import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SplitBar, segmentsOf } from './SplitBar';
import { IconPay, IconShares, IconSign } from './Icons';
import { Activity, explorerUrl, fetchActivity, Payout, prepareConfirmation, preparePayment, waitForConfirmation } from '../lib/chain';
import {
  allocate,
  formatPercent,
  formatSol,
  MEMBER_COLORS,
  parseSol,
  shortWallet,
  SplitConfig,
  splitReference,
  TREASURY_COLOR,
} from '../lib/split';
import { CLUSTER, IS_TEST_NETWORK } from '../lib/network';

type Busy = null | 'confirm' | 'pay' | 'airdrop';

function friendly(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(message)) return 'You cancelled the request in your wallet. Nothing was sent.';
  if (/429|Too Many Requests|rate/i.test(message)) return 'The network is busy. Wait a few seconds and try again.';
  if (/blockhash|expired/i.test(message)) return 'The request took too long and expired. Try again.';
  return 'That did not go through. Check your connection and try again.';
}

export function SplitPage({ config }: { config: SplitConfig }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const reference = useMemo(() => splitReference(config), [config]);

  const [activity, setActivity] = useState<Activity | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState<bigint | null>(null);
  const [justPaid, setJustPaid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  const me = publicKey?.toBase58();
  const myIndex = config.members.findIndex((m) => m.wallet === me);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchActivity(connection, config);
      if (!alive.current) return;
      // Never drop something we already saw: a slow RPC node can briefly lag behind.
      setActivity((prev) => {
        if (!prev) return next;
        const confirmed = new Set([...prev.confirmed, ...next.confirmed]);
        const seen = new Set(next.payouts.map((p) => p.signature));
        const payouts = [...next.payouts, ...prev.payouts.filter((p) => !seen.has(p.signature))].sort(
          (a, b) => (b.time ?? Infinity) - (a.time ?? Infinity),
        );
        return { confirmed, payouts };
      });
      setOffline(false);
    } catch {
      if (alive.current) setOffline(true);
    }
  }, [connection, config]);

  const refreshBalance = useCallback(async () => {
    if (!publicKey) return setBalance(null);
    try {
      const lamports = await connection.getBalance(publicKey, 'confirmed');
      if (alive.current) setBalance(BigInt(lamports));
    } catch {
      /* balance is a convenience; the payment dry run is the real check */
    }
  }, [connection, publicKey]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(refresh, 6000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  const confirmed = activity?.confirmed ?? new Set<string>();
  const waiting = config.members.filter((m) => !confirmed.has(m.wallet));
  const allConfirmed = activity !== null && waiting.length === 0;

  const lamports = parseSol(amount);
  const preview = lamports && lamports > 0n ? allocate(config, lamports) : null;

  async function send(build: () => Promise<import('@solana/web3.js').Transaction>): Promise<string> {
    const tx = await build();
    const signature = await sendTransaction(tx, connection);
    await waitForConfirmation(connection, signature, tx.lastValidBlockHeight);
    return signature;
  }

  async function confirmShare() {
    if (!publicKey) return;
    setBusy('confirm');
    setError('');
    setNotice('');
    try {
      await send(() => prepareConfirmation(connection, config, publicKey));
      setActivity((prev) => ({
        confirmed: new Set([...(prev?.confirmed ?? []), publicKey.toBase58()]),
        payouts: prev?.payouts ?? [],
      }));
      refresh();
      refreshBalance();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function pay() {
    if (!publicKey) return setVisible(true);
    if (!lamports || lamports <= 0n) return setError('Type the full prize amount first, for example 2.5');
    setBusy('pay');
    setError('');
    setNotice('');
    try {
      const prepared = await preparePayment(connection, config, publicKey, lamports);
      if (prepared.problem) {
        setError(prepared.problem);
        return;
      }
      const signature = await send(async () => prepared.transaction);
      const shares = allocate(config, lamports);
      const payout: Payout = {
        signature,
        time: Math.floor(Date.now() / 1000),
        payer: publicKey.toBase58(),
        total: lamports,
        members: shares.members,
        treasury: shares.treasury,
        staked: prepared.staked,
        matchesShares: true,
      };
      setActivity((prev) => ({
        confirmed: prev?.confirmed ?? new Set(),
        payouts: [payout, ...(prev?.payouts ?? []).filter((p) => p.signature !== signature)],
      }));
      if (prepared.stakingNote) setNotice(prepared.stakingNote);
      setJustPaid(signature);
      setAmount('');
      refresh();
      refreshBalance();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function getTestSol() {
    if (!publicKey) return;
    setBusy('airdrop');
    setError('');
    try {
      const signature = await connection.requestAirdrop(publicKey, LAMPORTS_PER_SOL);
      await waitForConfirmation(connection, signature);
      refreshBalance();
    } catch {
      setError('The free test SOL tap is empty right now. Get some at faucet.solana.com and come back.');
    } finally {
      setBusy(null);
    }
  }

  async function copyLink() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const field = document.createElement('textarea');
      field.value = url;
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const payouts = activity?.payouts ?? [];
  const totalPaid = payouts.reduce((sum, p) => sum + p.total, 0n);
  const stage: 'sign' | 'pay' | 'paid' = payouts.length ? 'paid' : allConfirmed ? 'pay' : 'sign';

  return (
    <div className="split">
      <section className="split-head">
        <h1>{config.name}</h1>
        <button type="button" className="btn btn-ghost" onClick={copyLink}>
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </section>

      <ol className="stages" aria-label="Progress">
        <li className={stage === 'sign' ? 'is-now' : 'is-done'}>
          <IconSign />
          <span>
            Sign
            <small>
              {activity ? `${config.members.length - waiting.length} of ${config.members.length}` : '…'}
            </small>
          </span>
        </li>
        <li className={stage === 'pay' ? 'is-now' : stage === 'paid' ? 'is-done' : ''}>
          <IconPay />
          <span>
            Pay
            <small>one transaction</small>
          </span>
        </li>
        <li className={stage === 'paid' ? 'is-now' : ''}>
          <IconShares />
          <span>
            Split
            <small>{payouts.length ? `${formatSol(totalPaid)} SOL paid` : 'everyone at once'}</small>
          </span>
        </li>
      </ol>

      <SplitBar segments={segmentsOf(config.members, config.treasury?.bps)} paid={justPaid !== null} />

      <section className="card">
        <ul className="people">
          {config.members.map((m, i) => {
            const isMe = i === myIndex;
            const done = confirmed.has(m.wallet);
            return (
              <li className="person" key={m.wallet}>
                <span className="dot" style={{ background: MEMBER_COLORS[i % MEMBER_COLORS.length] }} aria-hidden="true" />
                <div className="person-id">
                  <strong>
                    {m.name}
                    {isMe && <em>you</em>}
                    {m.staked && <em className="is-stake">staked</em>}
                  </strong>
                  <code title={m.wallet}>{shortWallet(m.wallet)}</code>
                </div>
                <span className="person-share">{formatPercent(m.bps)}</span>
                <span className="person-amount">{preview ? `${formatSol(preview.members[i])} SOL` : ''}</span>
                {done ? (
                  <span className="chip is-ok">Signed</span>
                ) : isMe ? (
                  <button type="button" className="btn btn-small" onClick={confirmShare} disabled={busy !== null}>
                    {busy === 'confirm' ? 'Signing…' : 'Sign my share'}
                  </button>
                ) : (
                  <span className="chip">{activity ? 'Waiting' : '…'}</span>
                )}
              </li>
            );
          })}
          {config.treasury && (
            <li className="person">
              <span className="dot" style={{ background: TREASURY_COLOR }} aria-hidden="true" />
              <div className="person-id">
                <strong>Team treasury</strong>
                <code title={config.treasury.wallet}>{shortWallet(config.treasury.wallet)}</code>
              </div>
              <span className="person-share">{formatPercent(config.treasury.bps)}</span>
              <span className="person-amount">{preview ? `${formatSol(preview.treasury)} SOL` : ''}</span>
              <span className="chip is-stake">Marinade</span>
            </li>
          )}
        </ul>
      </section>

      <section className="card pay">
        <h2>Pay the prize</h2>
        <p className="hint pay-lead">Whoever pays types the full prize here. Each share is calculated automatically.</p>
        <div className="pay-row">
          <label className="amount">
            <span className="sr">Amount in SOL</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^\d.,]/g, ''));
                setError('');
                setJustPaid(null);
              }}
              placeholder="0.00"
              aria-describedby="pay-help"
            />
            <b>SOL</b>
          </label>
          <button type="button" className="btn btn-primary" onClick={pay} disabled={busy !== null}>
            {busy === 'pay' ? 'Paying…' : publicKey ? 'Pay and split' : 'Connect wallet to pay'}
          </button>
        </div>
        <p className="hint" id="pay-help">
          {publicKey && balance !== null ? (
            <>
              Your wallet holds {formatSol(balance)} SOL.{' '}
              {IS_TEST_NETWORK && balance < 2n * BigInt(LAMPORTS_PER_SOL) && (
                <button type="button" className="link" onClick={getTestSol} disabled={busy !== null}>
                  {busy === 'airdrop' ? 'Requesting…' : 'Get 1 free test SOL'}
                </button>
              )}
            </>
          ) : (
            'Everyone is paid in one transaction, or nobody is.'
          )}
        </p>
        {!allConfirmed && activity && waiting.length > 0 && (
          <p className="warn">
            Waiting for {waiting.map((m) => m.name).join(' and ')} to sign. You can still pay.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="warn">{notice}</p>}
        {justPaid && (
          <p className="success" role="status">
            Paid and split.{' '}
            <a href={explorerUrl(justPaid, CLUSTER)} target="_blank" rel="noreferrer">
              See the transaction
            </a>
          </p>
        )}
      </section>

      <section className="card">
        <div className="rows-head">
          <h2>Payments</h2>
          
        </div>
        {offline && !activity && <p className="hint">Solana is not answering right now. Retrying…</p>}
        {activity && payouts.length === 0 && (
          <p className="hint">No payments yet.</p>
        )}
        <ul className="payouts">
          {payouts.map((p) => (
            <li key={p.signature} className={p.signature === justPaid ? 'is-new' : ''}>
              <div className="payout-top">
                <strong>{formatSol(p.total)} SOL</strong>
                <span className="muted">
                  from {shortWallet(p.payer)}
                  {p.time ? `, ${new Date(p.time * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
                </span>
                <span className={`chip ${p.matchesShares ? 'is-ok' : 'is-bad'}`}>
                  {p.matchesShares ? 'Verified' : 'Does not match shares'}
                </span>
              </div>
              <div className="payout-parts">
                {config.members.map((m, i) => (
                  <span key={m.wallet}>
                    <i style={{ background: MEMBER_COLORS[i % MEMBER_COLORS.length] }} />
                    {m.name} {formatSol(p.members[i])} SOL
                    {m.staked && p.staked ? ', staked' : ''}
                  </span>
                ))}
                {config.treasury && (
                  <span>
                    <i style={{ background: TREASURY_COLOR }} />
                    Treasury {formatSol(p.treasury)} SOL
                    {p.staked ? ', staked with Marinade' : ''}
                  </span>
                )}
                <a href={explorerUrl(p.signature, CLUSTER)} target="_blank" rel="noreferrer">
                  Receipt
                </a>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p className="ref">
        Split ID <code>{reference.toBase58()}</code>
      </p>
    </div>
  );
}
