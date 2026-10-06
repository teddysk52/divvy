import { useEffect, useMemo, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Create } from './components/Create';
import { SplitPage } from './components/SplitPage';
import { decodeSplit } from './lib/split';
import { CLUSTER, IS_TEST_NETWORK } from './lib/network';

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  const route = useMemo(() => {
    const match = hash.match(/^#\/s\/(.+)$/);
    if (!match) return { page: 'create' as const };
    const config = decodeSplit(match[1]);
    return config ? { page: 'split' as const, config } : { page: 'broken' as const };
  }, [hash]);

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#/" aria-label="Divvy home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
          </span>
          Divvy
        </a>
        <div className="top-right">
          {IS_TEST_NETWORK && (
            <span className="network" title="Payments on this network use test SOL with no real value">
              {CLUSTER === 'devnet' ? 'Devnet' : 'Testnet'}
            </span>
          )}
          <WalletMultiButton />
        </div>
      </header>

      <main>
        {route.page === 'create' && <Create />}
        {route.page === 'split' && <SplitPage key={hash} config={route.config} />}
        {route.page === 'broken' && (
          <section className="empty">
            <h1>This split link is incomplete</h1>
            <p>Part of the link is missing or was changed. Ask your teammate to copy the full link again, or create a new split.</p>
            <a className="btn btn-primary" href="#/">
              Create a split
            </a>
          </section>
        )}
      </main>

<footer className="foot">No server. Divvy never holds your money.</footer>
    </div>
  );
}
