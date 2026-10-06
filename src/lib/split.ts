import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';

/** One teammate and the share they agreed to, in basis points (100 bps = 1%). */
export interface Member {
  name: string;
  wallet: string;
  bps: number;
  /** When true, this share is staked with Marinade on arrival and delivered as mSOL. */
  staked?: boolean;
}

/** Optional team treasury. Its share is staked with Marinade when a payment arrives. */
export interface Treasury {
  wallet: string;
  bps: number;
}

export interface SplitConfig {
  v: 1;
  name: string;
  members: Member[];
  treasury?: Treasury;
}

export const TOTAL_BPS = 10_000;
export const MAX_MEMBERS = 8;

export function isValidWallet(value: string): boolean {
  try {
    new PublicKey(value.trim());
    return true;
  } catch {
    return false;
  }
}

/** Returns a list of human-readable problems. Empty list means the split is usable. */
export function validate(config: SplitConfig): string[] {
  const problems: string[] = [];
  if (!config.name.trim()) problems.push('Give the split a name.');
  if (config.members.length < 1) problems.push('Add at least one teammate.');
  if (config.members.length > MAX_MEMBERS) problems.push(`A split holds up to ${MAX_MEMBERS} teammates.`);

  const seen = new Set<string>();
  config.members.forEach((m, i) => {
    const label = m.name.trim() || `Teammate ${i + 1}`;
    if (!m.name.trim()) problems.push(`Teammate ${i + 1} needs a name.`);
    if (!isValidWallet(m.wallet)) problems.push(`${label} needs a valid Solana wallet address.`);
    else if (seen.has(m.wallet.trim())) problems.push(`${label} uses a wallet that is already in the split.`);
    seen.add(m.wallet.trim());
    if (!Number.isInteger(m.bps) || m.bps <= 0) problems.push(`${label} needs a share above 0%.`);
  });

  if (config.treasury) {
    if (!isValidWallet(config.treasury.wallet)) problems.push('The treasury needs a valid Solana wallet address.');
    if (!Number.isInteger(config.treasury.bps) || config.treasury.bps <= 0)
      problems.push('The treasury needs a share above 0%.');
  }

  const total = totalBps(config);
  if (total !== TOTAL_BPS) problems.push(`Shares add up to ${formatPercent(total)}. They must add up to 100%.`);
  return problems;
}

export function totalBps(config: SplitConfig): number {
  return config.members.reduce((sum, m) => sum + (m.bps || 0), 0) + (config.treasury?.bps || 0);
}

/** Same people and same shares always produce the same text, so the ID is stable. */
function canonical(config: SplitConfig): string {
  return JSON.stringify({
    v: 1,
    n: config.name.trim(),
    m: config.members.map((m) => (m.staked ? [m.name.trim(), m.wallet.trim(), m.bps, 1] : [m.name.trim(), m.wallet.trim(), m.bps])),
    t: config.treasury ? [config.treasury.wallet.trim(), config.treasury.bps] : null,
  });
}

/**
 * The split's on-chain reference. It is the SHA-256 of the agreed terms, used as
 * a read-only account on every confirmation and payment. Change one share and the
 * reference changes, so nobody can quietly edit the terms after people confirmed.
 */
export function splitReference(config: SplitConfig): PublicKey {
  return new PublicKey(sha256(new TextEncoder().encode(canonical(config))));
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((data.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The whole split lives in the link. No server, no account, nothing to take down. */
export function encodeSplit(config: SplitConfig): string {
  return toBase64Url(canonical(config));
}

export function decodeSplit(data: string): SplitConfig | null {
  try {
    const raw = JSON.parse(fromBase64Url(data));
    if (raw.v !== 1 || !Array.isArray(raw.m)) return null;
    const config: SplitConfig = {
      v: 1,
      name: String(raw.n ?? ''),
      members: raw.m.map((m: [string, string, number, number?]) => ({
        name: String(m[0]),
        wallet: String(m[1]),
        bps: Number(m[2]),
        ...(m[3] === 1 ? { staked: true } : {}),
      })),
      treasury: raw.t ? { wallet: String(raw.t[0]), bps: Number(raw.t[1]) } : undefined,
    };
    return validate(config).length === 0 ? config : null;
  } catch {
    return null;
  }
}

export interface Allocation {
  members: bigint[];
  treasury: bigint;
}

/**
 * Divides a payment by the agreed shares. Every lamport is accounted for: amounts
 * are rounded down and the few leftover lamports go to the treasury, or to the
 * largest shareholder when there is no treasury.
 */
export function allocate(config: SplitConfig, totalLamports: bigint): Allocation {
  const members = config.members.map((m) => (totalLamports * BigInt(m.bps)) / BigInt(TOTAL_BPS));
  let treasury = config.treasury ? (totalLamports * BigInt(config.treasury.bps)) / BigInt(TOTAL_BPS) : 0n;
  const remainder = totalLamports - members.reduce((a, b) => a + b, 0n) - treasury;
  if (config.treasury) treasury += remainder;
  else {
    let largest = 0;
    config.members.forEach((m, i) => {
      if (m.bps > config.members[largest].bps) largest = i;
    });
    members[largest] += remainder;
  }
  return { members, treasury };
}

export const LAMPORTS = 1_000_000_000n;

/** Parses "1.5" into lamports without floating point. Returns null for bad input. */
export function parseSol(input: string): bigint | null {
  const text = input.trim().replace(',', '.');
  if (!/^\d*\.?\d{0,9}$/.test(text) || text === '' || text === '.') return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole || '0') * LAMPORTS + BigInt(fraction.padEnd(9, '0'));
}

export function formatSol(lamports: bigint, maxDecimals = 4): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS;
  let fraction = (abs % LAMPORTS).toString().padStart(9, '0').slice(0, maxDecimals).replace(/0+$/, '');
  if (whole === 0n && fraction === '' && abs > 0n) fraction = (abs % LAMPORTS).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}${fraction ? '.' + fraction : ''}`;
}

export function formatPercent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

export function shortWallet(wallet: string): string {
  return wallet.length > 10 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet;
}

export const MEMBER_COLORS = ['#3D7BFF', '#FFB23F', '#F0567A', '#8A63F2', '#22B8CF', '#F2793D', '#6C8A2B', '#C04FC9'];
export const TREASURY_COLOR = '#16A37B';
