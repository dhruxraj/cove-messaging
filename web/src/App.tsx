import { useEffect } from 'react';
import { AuthScreen } from './components/Auth';
import { EncryptionRestore, EncryptionSetup, ProfileSetup, Unsupported } from './components/Setup';
import { Shell } from './components/Shell';
import { Spinner, Toasts } from './components/ui';
import { navigate, usePath } from './lib/router';
import { useApp } from './state/app';
import { useE2EE } from './state/crypto';

export function App() {
  const boot = useApp((s) => s.boot);
  const me = useApp((s) => s.me);
  const e2ee = useE2EE((s) => s.status);
  const path = usePath();

  useEffect(() => {
    if (boot !== 'ready') return;
    if (me && (path === '/login' || path === '/register')) navigate('/', { replace: true });
    if (!me && path !== '/login' && path !== '/register') navigate('/login', { replace: true });
  }, [boot, me, path]);

  let screen;
  if (boot === 'loading') screen = <Boot />;
  else if (!me) screen = <AuthScreen key={path} mode={path === '/register' ? 'register' : 'login'} />;
  else if (!me.setupComplete) screen = <ProfileSetup />;
  else if (e2ee === 'idle' || e2ee === 'checking') screen = <Boot />;
  else if (e2ee === 'unsupported') screen = <Unsupported />;
  else if (e2ee === 'needs_setup') screen = <EncryptionSetup />;
  else if (e2ee === 'needs_restore') screen = <EncryptionRestore />;
  else screen = <Shell path={path} />;

  return (
    <>
      {screen}
      <Toasts />
    </>
  );
}

function Boot() {
  return (
    <div className="boot">
      <Spinner label="Loading Cove" />
    </div>
  );
}
