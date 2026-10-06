# Divvy

Split a prize the moment it is paid. A team agrees on shares, each teammate signs them with their own wallet, and whoever pays sends **one Solana transaction** that delivers every share directly to its owner. Nobody holds the whole prize.

Any share can be marked **Stake it**: it is staked with **Marinade** inside the same transaction and arrives as mSOL. An optional team treasury share is always staked this way.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # share maths, link encoding, real transfers in an in-process Solana VM
npm run build    # production build in dist/
```

The app talks to **devnet** by default. To change network or use your own RPC node, create `.env`:

```
VITE_CLUSTER=devnet            # or mainnet-beta
VITE_RPC_URL=https://your-rpc  # optional
```

Phone wallets only open `https://` pages, so for a demo on two devices deploy `dist/` to any static host (Vercel, Netlify, GitHub Pages). There is no server to set up.

## How it works

- **The split is the link.** Names, wallets and shares are encoded in the URL. No database, no account.
- **Split ID.** The SHA-256 of the terms, used as a read-only account on every transaction. Change one share and the ID changes, so terms cannot be edited after people signed.
- **Signing.** A teammate sends a zero-value transaction tagged with the Split ID and a `divvy:confirm` memo. The page reads these from the chain to show who signed.
- **Paying.** One transaction holds a transfer per teammate, the treasury deposit, and a `divvy:pay:<lamports>` memo. Solana transactions are atomic: everyone is paid or nobody is.
- **Receipts.** The Payments list is rebuilt from chain history and each payment is checked against the agreed shares.

## Where Solana is used

| Need | Solana feature |
|---|---|
| Everyone paid at once, or not at all | Atomic multi-instruction transaction |
| Terms nobody can quietly change | Hash of terms as an on-chain reference account |
| Proof each teammate agreed | Wallet-signed memo transaction |
| Treasury that earns while it waits | Marinade liquid staking deposit (mSOL) |

## Files

- `src/lib/split.ts` shares, link encoding, Split ID, lamport-exact allocation
- `src/lib/chain.ts` transactions, dry run, history reading
- `src/lib/marinade.ts` Marinade deposit
- `src/components/` the two screens

## Known limits

- Pays in SOL. Stablecoin (USDC/USDG) payouts are the next step.
- If Marinade does not accept a deposit on the current network, the treasury share is sent as plain SOL and the page says so.
- A brand-new wallet must receive at least about 0.00089 SOL (Solana's account minimum).
- Up to 8 teammates per split.
