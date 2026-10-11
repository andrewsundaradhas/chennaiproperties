import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BrandMark, ErrorAlert, Field, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import type { AdminMeta } from '../lib/types';

interface Admin {
  email: string;
  display_name: string;
  role: string;
}
interface AdminCtx {
  admin: Admin;
  meta: AdminMeta;
  /** Call on any 401 so the UI returns to the login screen. */
  onUnauthorized: () => void;
}

const Ctx = createContext<AdminCtx | null>(null);
export function useAdmin(): AdminCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAdmin outside AdminApp');
  return c;
}

/** Wraps admin API calls: a 401 sends the user back to the login screen. */
export function useAdminApi() {
  const { onUnauthorized } = useAdmin();
  return useCallback(
    async <T,>(path: string, opts?: Parameters<typeof api>[1]) => {
      try {
        return await api<T>(path, opts);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        throw err;
      }
    },
    [onUnauthorized],
  );
}

export function AdminApp() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [meta, setMeta] = useState<AdminMeta | null>(null);
  const [state, setState] = useState<'loading' | 'anon' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    setState('loading');
    try {
      const me = await api<{ admin: Admin }>('/api/admin/auth/me');
      const m = await api<AdminMeta>('/api/admin/meta');
      setAdmin(me.admin);
      setMeta(m);
      setState('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState('anon');
      else {
        setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
        setState('error');
      }
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const onUnauthorized = useCallback(() => {
    setAdmin(null);
    setState('anon');
  }, []);

  if (state === 'loading') {
    return (
      <div className="login-wrap">
        <Spinner label="Checking session" />
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <ErrorAlert error={error} onRetry={() => void bootstrap()} />
        </div>
      </div>
    );
  }
  if (state === 'anon' || !admin || !meta) return <LoginPage onLoggedIn={() => void bootstrap()} />;

  return (
    <Ctx.Provider value={{ admin, meta, onUnauthorized }}>
      <AdminLayout admin={admin} onLoggedOut={onUnauthorized} />
    </Ctx.Provider>
  );
}

function AdminLayout({ admin, onLoggedOut }: { admin: Admin; onLoggedOut: () => void }) {
  const navigate = useNavigate();
  async function logout() {
    await api('/api/admin/auth/logout', { body: {} }).catch(() => undefined);
    onLoggedOut();
    navigate('/admin');
  }
  const link = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' active' : ''}`;
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin">
        <Link to="/admin" className="brand">
          <BrandMark />
          <span>
            <span className="brand-name">ChennaiProperties</span>
            <br />
            <span className="brand-sub">Staff dashboard</span>
          </span>
        </Link>
        <NavLink to="/admin" end className={link}>
          Overview
        </NavLink>
        <NavLink to="/admin/properties" className={link}>
          Properties
        </NavLink>
        <NavLink to="/admin/leads" className={link}>
          Leads
        </NavLink>
        <span className="spacer" />
        <div className="subtle" style={{ padding: '8px 10px' }}>
          Signed in as
          <br />
          <strong>{admin.display_name}</strong>
        </div>
        <button className="btn btn-sm" onClick={() => void logout()}>
          Sign out
        </button>
        <Link to="/" className="nav-link subtle">
          ← Customer chat
        </Link>
      </nav>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}

function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/auth/login', { body: { email, password } });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-wrap">
      <form className="login-card panel panel-pad stack" onSubmit={submit}>
        <div className="row">
          <BrandMark />
          <div>
            <h1 style={{ fontSize: '1.2rem' }}>Staff sign in</h1>
            <p className="subtle">ChennaiProperties dashboard</p>
          </div>
        </div>
        <Field label="Email">
          {(p) => <input {...p} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <Field label="Password">
          {(p) => (
            <input {...p} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          )}
        </Field>
        <ErrorAlert error={error} />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="subtle">
          No account? Create one with <span className="mono">npm run admin:create -- --email you@example.com</span>
        </p>
        <Link to="/" className="subtle">
          ← Back to customer chat
        </Link>
      </form>
    </div>
  );
}
