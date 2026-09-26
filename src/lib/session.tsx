import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Parse from '../parse';
import { completeGoogleSignIn } from './googleSignIn';
import { formatMoney } from './format';
import { forgetPush } from './push';

export type Role = 'admin' | 'cashier' | 'rider';

export type AppConfig = {
  restaurantName: string;
  currencySymbol: string;
  currencyCode: string;
  timezone: string;
  defaultDeliveryFee: number;
  maxRiderFloat: number;
  allowBatching: boolean;
  commissionRounding?: string;
  requireCashierConfirmForPickup?: boolean;
  mobileMoney?: MerchantAccount[];
  restaurantNameSet?: boolean;
  floatWarningPercent?: number;
};

export type MerchantAccount = { provider: string; label: string; code: string; name: string };

export type Profile = {
  id: string;
  username: string;
  name: string;
  phone: string;
  role: Role | null;
  code: string;
  commission: { type: string; perOrder: number; percent: number } | null;
  canInitialize: boolean;
  config: AppConfig;
};

export type AppInfo = {
  restaurantName: string;
  currencySymbol: string;
  currencyCode: string;
  timezone: string;
  ownerSetupOpen: boolean;
  previewEnabled: boolean;
};

// Only used until the server answers; real values come from Configuration.
const FALLBACK_INFO: AppInfo = {
  restaurantName: 'Relay',
  currencySymbol: '',
  currencyCode: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  ownerSetupOpen: false,
  previewEnabled: false,
};

// Build-time switch for the demo mode; the server must also allow it.
const PREVIEW_BUILD = import.meta.env.VITE_ENABLE_PREVIEW === 'true';

type Session = {
  status: 'loading' | 'ready';
  user: Parse.User | null;
  profile: Profile | null;
  appInfo: AppInfo;
  // Set when getAppInfo fails: usually the Cloud Code is not deployed or not running.
  serverError: string;
  config: AppConfig;
  preview: boolean;
  previewAvailable: boolean;
  error: string;
  setUser: (user: Parse.User) => void;
  startPreview: () => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<Parse.User | null>(() => Parse.User.current() ?? null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo>(FALLBACK_INFO);
  const [preview, setPreview] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(!!user);
  const [error, setError] = useState('');
  const [serverError, setServerError] = useState('');

  useEffect(() => {
    Parse.Cloud.run('getAppInfo')
      .then((info: AppInfo) => setAppInfo(info))
      .catch((e) => setServerError(e instanceof Error ? e.message : String(e)));
    completeGoogleSignIn()
      .then((signedIn) => signedIn && setUserState(signedIn))
      .catch(() => undefined);
  }, []);

  const logout = useCallback(async () => {
    await forgetPush();
    try {
      await Parse.User.logOut();
    } catch {
      // Session already invalid on the server; clearing it locally is enough.
    }
    setUserState(null);
    setProfile(null);
    setPreview(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoadingProfile(true);
    try {
      setProfile(await Parse.Cloud.run('getMyProfile'));
      setError('');
    } catch (e) {
      if (e instanceof Parse.Error && e.code === Parse.Error.INVALID_SESSION_TOKEN) {
        await logout();
      } else if (e instanceof Parse.Error && e.message === 'Account is inactive') {
        await logout();
        setError('This account has been deactivated. Ask your administrator.');
      } else {
        setError(e instanceof Error ? e.message : 'Could not load your account');
      }
    } finally {
      setLoadingProfile(false);
    }
  }, [user, logout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const previewAvailable = PREVIEW_BUILD && appInfo.previewEnabled;
  const config = useMemo<AppConfig>(
    () =>
      profile?.config ?? {
        restaurantName: appInfo.restaurantName,
        currencySymbol: appInfo.currencySymbol,
        currencyCode: appInfo.currencyCode,
        timezone: appInfo.timezone,
        defaultDeliveryFee: 0,
        maxRiderFloat: 0,
        allowBatching: false,
      },
    [profile, appInfo],
  );

  const value: Session = {
    status: loadingProfile ? 'loading' : 'ready',
    user,
    profile,
    appInfo,
    serverError,
    config,
    preview,
    previewAvailable,
    error,
    setUser: (next) => {
      setError('');
      setLoadingProfile(true);
      setUserState(next);
    },
    startPreview: () => previewAvailable && setPreview(true),
    refresh,
    logout,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}

export const useConfig = () => useSession().config;

export function useMoney() {
  const { currencySymbol } = useConfig();
  return useCallback(
    (amount: number | null | undefined) => formatMoney(amount, currencySymbol),
    [currencySymbol],
  );
}

export function homePath(role: Role | null): string {
  return role === 'admin' ? '/admin' : role === 'cashier' ? '/cashier' : '/rider';
}
