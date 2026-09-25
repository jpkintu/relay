import { useEffect, useState } from 'react';
import Parse from './parse';
import { completeGoogleSignIn } from './lib/googleSignIn';
import { AuthScreen } from './components/AuthScreen';
import { RiderWorkspace } from './components/RiderWorkspace';
import { CashierWorkspace } from './components/CashierWorkspace';
import { AdminWorkspace } from './components/AdminWorkspace';

type Role = 'rider' | 'cashier' | 'admin';

export default function App() {
  const [user, setUser] = useState<Parse.User | null>(() => Parse.User.current());
  const [preview, setPreview] = useState(() => !Parse.User.current());
  const [role, setRole] = useState<Role>('rider');
  const [canInitialize, setCanInitialize] = useState(false);
  const [setupError, setSetupError] = useState('');

  useEffect(() => {
    completeGoogleSignIn()
      .then((signedIn) => signedIn && setUser(signedIn))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!user) return;
    const query = new Parse.Query(Parse.Role);
    query.equalTo('users', user);
    query
      .find()
      .then((roles) => {
        const names = roles.map((item) => item.getName());
        setCanInitialize(names.length === 0);
        setRole(
          names.includes('admin') ? 'admin' : names.includes('cashier') ? 'cashier' : 'rider',
        );
      })
      .catch(() => {
        setRole('rider');
        setCanInitialize(true);
      });
  }, [user?.id]);

  if (!user && !preview)
    return <AuthScreen onAuthenticated={setUser} onPreview={() => setPreview(true)} />;
  const exit = async () => {
    if (user) await Parse.User.logOut();
    setUser(null);
    setPreview(false);
  };
  const workspace =
    role === 'cashier' ? (
      <CashierWorkspace onExit={exit} preview={preview} />
    ) : role === 'admin' ? (
      <AdminWorkspace onExit={exit} preview={preview} />
    ) : (
      <RiderWorkspace user={preview ? null : user} preview={preview} onExit={exit} />
    );
  return (
    <div className={preview ? 'preview-app' : undefined}>
      {workspace}
      {user && canInitialize && !preview && (
        <div className="owner-initialize">
          <span>First owner account? Set up administrator access.</span>
          <button
            onClick={async () => {
              try {
                await Parse.Cloud.run('bootstrapOwner');
                setCanInitialize(false);
                setRole('admin');
                setSetupError('');
              } catch (e) {
                setSetupError(e instanceof Error ? e.message : 'Unable to initialize owner');
              }
            }}
          >
            Initialize owner
          </button>
          {setupError && <small>{setupError}</small>}
        </div>
      )}
      <nav className="role-switch" aria-label="Preview role navigation">
        <strong>{preview ? 'LIVE PREVIEW' : 'RELAY'}</strong>
        {preview &&
          (['rider', 'cashier', 'admin'] as Role[]).map((item) => (
            <button
              className={role === item ? 'active' : ''}
              onClick={() => setRole(item)}
              key={item}
            >
              {item}
            </button>
          ))}
        <button
          className="preview-login"
          onClick={() => {
            setPreview((p) => !p);
            setRole('rider');
          }}
        >
          {preview ? 'Sign in' : 'Preview roles'}
        </button>
      </nav>
    </div>
  );
}
