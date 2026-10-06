import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

export const MARINADE_PROGRAM_ID = new PublicKey('MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD');

/**
 * Stakes SOL with Marinade and delivers the mSOL to the team treasury.
 * The SDK is loaded only when a split actually has a treasury.
 */
export async function marinadeDepositInstructions(
  connection: Connection,
  payer: PublicKey,
  treasury: PublicKey,
  lamports: bigint,
): Promise<TransactionInstruction[]> {
  const [{ Marinade, MarinadeConfig }, { default: BN }] = await Promise.all([
    import('@marinade.finance/marinade-ts-sdk'),
    import('bn.js'),
  ]);
  const marinade = new Marinade(new MarinadeConfig({ connection, publicKey: payer }));
  const { transaction } = await marinade.deposit(new BN(lamports.toString()), { mintToOwnerAddress: treasury });
  return transaction.instructions;
}
