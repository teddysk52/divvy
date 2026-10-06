import { describe, expect, it } from 'vitest';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { MARINADE_PROGRAM_ID } from '../src/lib/marinade';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { confirmInstructions, MEMO_PROGRAM_ID, payInstructions, readTransaction } from '../src/lib/chain';
import { allocate, SplitConfig, splitReference } from '../src/lib/split';

/** Runs the real instructions inside an in-process Solana VM. */
function setup() {
  const svm = new LiteSVM();
  const payer = Keypair.generate();
  const ivan = Keypair.generate();
  const yana = Keypair.generate();
  const treasury = Keypair.generate();
  for (const k of [payer, ivan, yana, treasury]) svm.airdrop(k.publicKey, BigInt(100 * LAMPORTS_PER_SOL));
  const config: SplitConfig = {
    v: 1,
    name: 'Demo',
    members: [
      { name: 'Ivan', wallet: ivan.publicKey.toBase58(), bps: 4000 },
      { name: 'Yana', wallet: yana.publicKey.toBase58(), bps: 4000 },
    ],
    treasury: { wallet: treasury.publicKey.toBase58(), bps: 2000 },
  };
  return { svm, payer, ivan, yana, treasury, config };
}

/**
 * The in-process VM runs native programs (System) reliably, but executing the
 * on-chain Memo program crashes its JIT in some sandboxes. So money movement is
 * executed for real here, and the memo instruction is checked by shape below.
 */
function withoutMemo(tx: Transaction): Transaction {
  return new Transaction().add(...tx.instructions.filter((ix) => !ix.programId.equals(MEMO_PROGRAM_ID)));
}

function send(svm: LiteSVM, signer: Keypair, full: Transaction) {
  const tx = withoutMemo(full);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(signer);
  const result = svm.sendTransaction(tx);
  if (result instanceof FailedTransactionMetadata) throw new Error(result.toString());
  return result;
}

/** Size of the complete transaction, memo included, as a wallet would send it. */
function fullSize(svm: LiteSVM, signer: Keypair, tx: Transaction): number {
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(signer);
  return tx.serialize().length;
}

describe('on-chain instructions', () => {
  it('lets a teammate confirm without moving money', () => {
    const { svm, ivan, config } = setup();
    const before = svm.getBalance(ivan.publicKey)!;
    const tx = new Transaction().add(...confirmInstructions(config, ivan.publicKey));
    send(svm, ivan, tx);
    const memo = tx.instructions.find((ix) => ix.programId.equals(MEMO_PROGRAM_ID))!;
    expect(memo.data.toString('utf8')).toBe('divvy:confirm');
    expect(memo.keys).toEqual([{ pubkey: ivan.publicKey, isSigner: true, isWritable: false }]);
    expect(before - svm.getBalance(ivan.publicKey)!).toBe(5000n); // network fee only
    // The split reference is on the transaction, so the history query can find it.
    tx.feePayer = ivan.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    const keys = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    expect(keys).toContain(splitReference(config).toBase58());
  });

  it('pays every share in one transaction', () => {
    const { svm, payer, ivan, yana, treasury, config } = setup();
    const total = 10n * BigInt(LAMPORTS_PER_SOL) + 7n;
    const expected = allocate(config, total);
    const before = [ivan, yana, treasury, payer].map((k) => svm.getBalance(k.publicKey)!);
    const tx = new Transaction().add(...payInstructions(config, payer.publicKey, total));
    send(svm, payer, tx);
    const after = [ivan, yana, treasury, payer].map((k) => svm.getBalance(k.publicKey)!);
    expect(after[0] - before[0]).toBe(expected.members[0]);
    expect(after[1] - before[1]).toBe(expected.members[1]);
    expect(after[2] - before[2]).toBe(expected.treasury);
    expect(before[3] - after[3]).toBe(total + 5000n);
    expect(fullSize(svm, payer, tx)).toBeLessThan(1232);
  });

  it('pays nobody when the payer cannot cover the full amount', () => {
    const { svm, payer, ivan, yana, config } = setup();
    const before = [ivan, yana].map((k) => svm.getBalance(k.publicKey)!);
    const tx = new Transaction().add(...payInstructions(config, payer.publicKey, 1000n * BigInt(LAMPORTS_PER_SOL)));
    expect(() => send(svm, payer, tx)).toThrow();
    expect([ivan, yana].map((k) => svm.getBalance(k.publicKey)!)).toEqual(before);
  });

  it('fits eight teammates in one transaction', () => {
    const { svm, payer } = setup();
    const config: SplitConfig = {
      v: 1,
      name: 'Big team',
      members: Array.from({ length: 8 }, (_, i) => ({ name: `M${i}`, wallet: Keypair.generate().publicKey.toBase58(), bps: 1250 })),
    };
    const tx = new Transaction().add(...payInstructions(config, payer.publicKey, 8n * BigInt(LAMPORTS_PER_SOL)));
    send(svm, payer, tx);
    expect(fullSize(svm, payer, tx)).toBeLessThan(1232);
    config.members.forEach((m) => expect(svm.getBalance(new PublicKey(m.wallet))).toBe(BigInt(LAMPORTS_PER_SOL)));
  });
});

/** Shapes instructions the way the RPC returns them, to test history reading. */
function asParsed(config: SplitConfig, signer: PublicKey, tx: Transaction, extraKeys: PublicKey[] = []) {
  const instructions = tx.instructions.map((ix) => {
    if (ix.programId.equals(SystemProgram.programId)) {
      return {
        programId: ix.programId,
        program: 'system',
        parsed: {
          type: 'transfer',
          info: {
            source: ix.keys[0].pubkey.toBase58(),
            destination: ix.keys[1].pubkey.toBase58(),
            lamports: Number(ix.data.readBigUInt64LE(4)),
          },
        },
      };
    }
    if (ix.programId.equals(MARINADE_PROGRAM_ID))
      return { programId: ix.programId, accounts: ix.keys.map((k) => k.pubkey), data: bs58.encode(ix.data) };
    return { programId: ix.programId, program: 'spl-memo', parsed: ix.data.toString('utf8') };
  });
  return {
    blockTime: 1_790_000_000,
    meta: { err: null },
    transaction: { message: { accountKeys: [signer, ...extraKeys].map((pubkey) => ({ pubkey })), instructions } },
  } as any;
}

describe('reading history', () => {
  it('recognises confirmations and verified payouts', () => {
    const { payer, ivan, config } = setup();
    const confirm = new Transaction().add(...confirmInstructions(config, ivan.publicKey));
    expect(readTransaction(config, 'sig1', asParsed(config, ivan.publicKey, confirm)).confirmedBy).toBe(ivan.publicKey.toBase58());

    const total = 5n * BigInt(LAMPORTS_PER_SOL);
    const pay = new Transaction().add(...payInstructions(config, payer.publicKey, total));
    const { payout } = readTransaction(config, 'sig2', asParsed(config, payer.publicKey, pay));
    expect(payout!.total).toBe(total);
    expect(payout!.members).toEqual(allocate(config, total).members);
    expect(payout!.treasury).toBe(allocate(config, total).treasury);
    expect(payout!.matchesShares).toBe(true);
    expect(payout!.staked).toBe(false);
  });

  it('verifies staked shares by the amount deposited to Marinade', () => {
    const { payer, ivan, config } = setup();
    config.members[0].staked = true;
    const total = 5n * BigInt(LAMPORTS_PER_SOL);
    const shares = allocate(config, total);
    const deposit = (lamports: bigint) => {
      const data = Buffer.alloc(16);
      data.writeBigUInt64LE(lamports, 8);
      return new TransactionInstruction({ programId: MARINADE_PROGRAM_ID, keys: [{ pubkey: ivan.publicKey, isSigner: false, isWritable: true }], data });
    };
    const build = (ivanDeposit: bigint) =>
      new Transaction().add(
        ...payInstructions(config, payer.publicKey, total, { members: { 0: [deposit(ivanDeposit)] }, treasury: [deposit(shares.treasury)] }),
      );
    const read = (tx: Transaction) => readTransaction(config, 's', asParsed(config, payer.publicKey, tx, [MARINADE_PROGRAM_ID])).payout!;

    const good = read(build(shares.members[0]));
    expect(good.staked).toBe(true);
    expect(good.members).toEqual(shares.members);
    expect(good.treasury).toBe(shares.treasury);
    expect(good.matchesShares).toBe(true);
    // Someone stakes less than Ivan's share: the receipt must not say it matches.
    expect(read(build(shares.members[0] - 1n)).matchesShares).toBe(false);
  });

  it('flags a payment that claims one total but sends different amounts', () => {
    const { payer, config } = setup();
    const honest = payInstructions(config, payer.publicKey, 5n * BigInt(LAMPORTS_PER_SOL));
    const lying = payInstructions(config, payer.publicKey, 50n * BigInt(LAMPORTS_PER_SOL));
    const forged = new Transaction().add(...honest.slice(0, -1), lying[lying.length - 1]);
    const { payout } = readTransaction(config, 'sig3', asParsed(config, payer.publicKey, forged));
    expect(payout!.matchesShares).toBe(false);
  });
});
