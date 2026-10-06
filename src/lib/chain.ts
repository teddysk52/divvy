import {
  Connection,
  ParsedTransactionWithMeta,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { allocate, SplitConfig, splitReference } from './split';
import { MARINADE_PROGRAM_ID, marinadeDepositInstructions } from './marinade';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const CONFIRM_MEMO = 'divvy:confirm';
const PAY_MEMO = 'divvy:pay:';

function memo(text: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8'),
  });
}

/** Tags an instruction with the split reference so the split's history can be found on-chain. */
function tag(ix: TransactionInstruction, reference: PublicKey): TransactionInstruction {
  ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  return ix;
}

/** A teammate signs the agreed terms. Costs only the network fee, moves no money. */
export function confirmInstructions(config: SplitConfig, member: PublicKey): TransactionInstruction[] {
  const reference = splitReference(config);
  return [
    tag(SystemProgram.transfer({ fromPubkey: member, toPubkey: member, lamports: 0 }), reference),
    memo(CONFIRM_MEMO, member),
  ];
}

/** Marinade deposits that replace plain transfers, per recipient. */
export interface Staking {
  /** Deposit instructions by teammate index. */
  members?: Record<number, TransactionInstruction[]>;
  treasury?: TransactionInstruction[];
}

/**
 * One payment, every share. All transfers sit in a single transaction, so either
 * everyone is paid or nobody is — there is no moment where one person holds it all.
 */
export function payInstructions(
  config: SplitConfig,
  payer: PublicKey,
  totalLamports: bigint,
  staking: Staking = {},
): TransactionInstruction[] {
  const reference = splitReference(config);
  const shares = allocate(config, totalLamports);
  const ixs: TransactionInstruction[] = [tag(memoAnchor(payer), reference)];

  config.members.forEach((m, i) => {
    if (shares.members[i] <= 0n) return;
    const deposit = staking.members?.[i];
    if (deposit?.length) ixs.push(...deposit);
    else ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(m.wallet), lamports: shares.members[i] }));
  });

  if (config.treasury && shares.treasury > 0n) {
    if (staking.treasury?.length) ixs.push(...staking.treasury);
    else
      ixs.push(
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(config.treasury.wallet), lamports: shares.treasury }),
      );
  }

  ixs.push(memo(`${PAY_MEMO}${totalLamports}`, payer));
  return ixs;
}

/** A zero-lamport self transfer that only exists to carry the split reference. */
function memoAnchor(payer: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 });
}

export interface PreparedPayment {
  transaction: Transaction;
  /** True when the treasury share is staked with Marinade inside this transaction. */
  staked: boolean;
  /** Why staking was skipped, when it was. */
  stakingNote?: string;
  /** Set when the network says this payment would fail. Explains why in plain words. */
  problem?: string;
}

async function finalize(connection: Connection, payer: PublicKey, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs);
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = payer;
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  return tx;
}

/** Turns a failed dry run into a sentence a person can act on. Exported for tests. */
export function explainFailure(err: unknown, logs: string[] | null): string {
  const text = JSON.stringify(err) + ' ' + (logs ?? []).join(' ');
  if (/InsufficientFundsForRent/i.test(text))
    return 'One of the wallets is brand new and its share is below the 0.00089 SOL minimum Solana requires to open an account. Pay a larger amount.';
  if (/insufficient lamports|InsufficientFundsForFee|"Custom":1\b/i.test(text))
    return 'Your wallet does not hold enough SOL for this payment and the network fee.';
  if (/AccountNotFound/i.test(text)) return 'Your wallet has no SOL on this network yet.';
  return 'The network rejected this payment. Check the amount and try again.';
}

async function dryRun(connection: Connection, tx: Transaction): Promise<string | undefined> {
  const sim = await connection.simulateTransaction(tx);
  return sim.value.err ? explainFailure(sim.value.err, sim.value.logs) : undefined;
}

/** True when any share of this split is meant to be staked. */
export function wantsStaking(config: SplitConfig): boolean {
  return Boolean(config.treasury) || config.members.some((m) => m.staked);
}

/**
 * Builds the payment and dry-runs it. Shares marked as staked go through Marinade
 * and arrive as mSOL. If Marinade does not accept the deposits on this network,
 * those shares are sent as plain SOL instead, so a payment never fails because of staking.
 */
export async function preparePayment(
  connection: Connection,
  config: SplitConfig,
  payer: PublicKey,
  totalLamports: bigint,
): Promise<PreparedPayment> {
  const shares = allocate(config, totalLamports);
  let stakingNote: string | undefined;

  if (wantsStaking(config)) {
    try {
      const staking: Staking = { members: {} };
      for (let i = 0; i < config.members.length; i++) {
        const m = config.members[i];
        if (m.staked && shares.members[i] > 0n)
          staking.members![i] = await marinadeDepositInstructions(connection, payer, new PublicKey(m.wallet), shares.members[i]);
      }
      if (config.treasury && shares.treasury > 0n)
        staking.treasury = await marinadeDepositInstructions(connection, payer, new PublicKey(config.treasury.wallet), shares.treasury);

      const tx = await finalize(connection, payer, payInstructions(config, payer, totalLamports, staking));
      const tooLarge = (() => {
        try {
          return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length > 1232;
        } catch {
          return true;
        }
      })();
      if (!tooLarge && !(await dryRun(connection, tx))) return { transaction: tx, staked: true };
      stakingNote = tooLarge
        ? 'Too many staked shares for one transaction, so staked shares are sent as SOL this time.'
        : 'Marinade did not accept the deposit on this network, so staked shares are sent as SOL.';
    } catch {
      stakingNote = 'Marinade is not reachable on this network, so staked shares are sent as SOL.';
    }
  }

  const transaction = await finalize(connection, payer, payInstructions(config, payer, totalLamports));
  return { transaction, staked: false, stakingNote, problem: await dryRun(connection, transaction) };
}

export async function prepareConfirmation(connection: Connection, config: SplitConfig, member: PublicKey) {
  return finalize(connection, member, confirmInstructions(config, member));
}

export interface Payout {
  signature: string;
  time: number | null;
  payer: string;
  total: bigint;
  /** Lamports each teammate received, in the split's order. */
  members: bigint[];
  treasury: bigint;
  staked: boolean;
  /** True when every transfer matches the agreed shares exactly. */
  matchesShares: boolean;
}

export interface Activity {
  /** Wallets that signed the terms. */
  confirmed: Set<string>;
  payouts: Payout[];
}

/** Reads one parsed transaction into a confirmation or a payout. Exported for tests. */
export function readTransaction(
  config: SplitConfig,
  signature: string,
  tx: ParsedTransactionWithMeta,
): { confirmedBy?: string; payout?: Payout } {
  if (tx.meta?.err) return {};
  const keys = tx.transaction.message.accountKeys;
  const signer = keys[0].pubkey.toBase58();
  let memoText = '';
  const received = new Map<string, bigint>();

  let depositedToMarinade = 0n;

  for (const ix of tx.transaction.message.instructions) {
    if (!('parsed' in ix)) {
      // Marinade deposit: 8-byte instruction id, then the lamports as a u64.
      if (ix.programId.equals(MARINADE_PROGRAM_ID)) {
        try {
          const data = Buffer.from(bs58.decode(ix.data));
          if (data.length >= 16) depositedToMarinade += data.readBigUInt64LE(8);
        } catch {
          /* unreadable data simply fails the share check below */
        }
      }
      continue;
    }
    if (ix.programId.equals(MEMO_PROGRAM_ID) && typeof ix.parsed === 'string') memoText = ix.parsed;
    if (ix.programId.equals(SystemProgram.programId) && ix.parsed?.type === 'transfer') {
      const { source, destination, lamports } = ix.parsed.info;
      if (source === signer) received.set(destination, (received.get(destination) ?? 0n) + BigInt(lamports));
    }
  }

  if (memoText === CONFIRM_MEMO) return { confirmedBy: signer };
  if (!memoText.startsWith(PAY_MEMO)) return {};

  let total: bigint;
  try {
    total = BigInt(memoText.slice(PAY_MEMO.length));
  } catch {
    return {};
  }
  const expected = allocate(config, total);
  const staked = keys.some((k) => k.pubkey.equals(MARINADE_PROGRAM_ID));
  const viaMarinade = (plain: bigint, wanted: boolean) => staked && wanted && plain === 0n;

  let expectedDeposits = 0n;
  const members = config.members.map((m, i) => {
    const plain = received.get(m.wallet) ?? 0n;
    if (!viaMarinade(plain, Boolean(m.staked))) return plain;
    expectedDeposits += expected.members[i];
    return expected.members[i];
  });
  const treasuryPlain = config.treasury ? received.get(config.treasury.wallet) ?? 0n : 0n;
  let treasury = treasuryPlain;
  if (config.treasury && viaMarinade(treasuryPlain, true)) {
    treasury = expected.treasury;
    expectedDeposits += expected.treasury;
  }
  // Plain transfers must match exactly, and the total staked must equal the staked shares.
  const matchesShares =
    members.every((amount, i) => amount === expected.members[i]) &&
    treasury === expected.treasury &&
    depositedToMarinade === expectedDeposits;

  return {
    payout: {
      signature,
      time: tx.blockTime ?? null,
      payer: signer,
      total,
      members,
      treasury,
      staked,
      matchesShares,
    },
  };
}

/** Everything that ever happened to this split, read straight from the chain. */
export async function fetchActivity(connection: Connection, config: SplitConfig): Promise<Activity> {
  const reference = splitReference(config);
  const signatures = await connection.getSignaturesForAddress(reference, { limit: 40 }, 'confirmed');
  const ok = signatures.filter((s) => !s.err);
  const transactions = await Promise.all(
    ok.map((s) =>
      connection
        .getParsedTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
        .catch(() => null),
    ),
  );

  const memberWallets = new Set(config.members.map((m) => m.wallet));
  const confirmed = new Set<string>();
  const payouts: Payout[] = [];
  transactions.forEach((tx, i) => {
    if (!tx) return;
    const result = readTransaction(config, ok[i].signature, tx);
    if (result.confirmedBy && memberWallets.has(result.confirmedBy)) confirmed.add(result.confirmedBy);
    if (result.payout) payouts.push(result.payout);
  });
  return { confirmed, payouts };
}

/**
 * Waits for a transaction by polling its status. Polling works on any RPC node,
 * unlike websocket subscriptions, which public nodes often drop in browsers.
 */
export async function waitForConfirmation(connection: Connection, signature: string, lastValidBlockHeight?: number): Promise<void> {
  const deadline = Date.now() + 75_000;
  let checks = 0;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]).catch(() => ({ value: [null] }));
    const status = value[0];
    if (status?.err) throw new Error('The transaction failed on-chain.');
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    if (lastValidBlockHeight && ++checks % 8 === 0) {
      const height = await connection.getBlockHeight('confirmed').catch(() => 0);
      if (height > lastValidBlockHeight) throw new Error('The transaction expired before it was confirmed.');
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error('The transaction expired before it was confirmed.');
}

export function explorerUrl(signature: string, cluster: string): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}
