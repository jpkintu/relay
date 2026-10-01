import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Parse from '../parse';
import { completeGoogleSignIn } from './googleSignIn';
import { formatMoney } from './format';
import { forgetPush } from './push';
import { applyTheme, type Theme } from './theme';
import { rememberRestaurant, restaurantCode } from './restaurant';

export type Role = 'admin' | 'finance' | 'cashier' | 'rider';

export type AppConfig = {
  restaurantName: string;
  // The restaurant's own logo (Settings), '' when none.
  restaurantLogo?: string;
  // Theme colours (Admin → Branding); '' keeps Relay's.
  theme?: Theme;
  currencySymbol: string;
  currencyCode: string;
  timezone: string;
  defaultDeliveryFee: number;
  maxRiderFloat: number;
  allowBatching: boolean;
  commissionRounding?: string;
  requireCashierConfirmForPickup?: boolean;
  mobileMoney?: MerchantAccount[];
  // Card machine at the counter (Settings → Card payments); null when off.
  card?: MerchantAccount | null;
  restaurantNameSet?: boolean;
  floatWarningPercent?: number;
  // Where maps open: the restaurant (Settings).
  mapCenter?: { lat: number; lng: number };
  // Which kinds of order this restaurant takes (Settings → Modules).
  modules?: { riderOrders: boolean; callIn: boolean; counter: boolean };
  // Printed receipts (Settings → Receipts).
  receipt?: { width: number; header: string; footer: string; autoPrintKitchen: boolean };
  // The cash drawer (Settings → Cash drawer) and when it opens; null when off.
  drawer?: { onSale: boolean; onHandover: boolean; onPayout: boolean; onShift: boolean } | null;
  // Pictures beside the sign-in form (Admin → Branding).
  loginImages?: LoginImage[];
};

export type LoginImage = { url: string; caption: string };

export type MerchantAccount = {
  provider: string;
  label: string;
  code: string;
  name: string;
  // Automatic payments on (Admin → Payments): the app can ask the
  // customer's phone to pay instead of waiting for a transaction ID.
  auto?: boolean;
};

export type Profile = {
  id: string;
  username: string;
  name: string;
  phone: string;
  role: Role | null;
  code: string;
  // Riders only: false while on a break.
  available?: boolean | null;
  commission: { type: string; perOrder: number; percent: number } | null;
  canInitialize: boolean;
  // Relay Hosted: the person's restaurant and its subscription.
  restaurant?: RestaurantSummary | null;
  // Relay Hosted: Relay's own staff (no restaurant) get the platform console.
  platform?: boolean;
  config: AppConfig;
  // Where a rider or cashier works; how many open branches there are.
  branch?: { id: string; name: string } | null;
  branchCount?: number;
  // Parts of the app this restaurant has (plan limits on Relay Hosted).
  features?: {
    branches: boolean;
    finance: boolean;
    accounting: boolean;
    reports?: boolean;
    efris?: boolean;
    whatsapp?: boolean;
  };
};

export type RestaurantSummary = {
  id: string;
  code: string;
  name: string;
  status: 'trial' | 'active' | 'past_due' | 'expired' | 'suspended';
  usable: boolean;
  until: string | null;
  trialEndsAt: string | null;
  paidUntil: string | null;
  monthlyPrice: number;
  // Relay Hosted plans (lib/limits.js on the server).
  plan?: string;
  planName?: string;
  // Relay Hosted: where Relay emails the owner (password resets, reminders).
  ownerEmail?: string;
  // A year paid at once (Admin → Billing).
  annualPrice?: number;
  billingFrom?: string;
  ownerName?: string;
  billingPhone?: string;
  trialDays?: number;
  // Signed up to pay now: closed until the first payment, with its code.
  payFirst?: boolean;
  offerCode?: string;
  currency: string;
  graceDays: number;
  supportContact: string;
};

export type AppInfo = {
  restaurantName: string;
  restaurantLogo?: string;
  theme?: Theme;
  currencySymbol: string;
  currencyCode: string;
  timezone: string;
  ownerSetupOpen: boolean;
  previewEnabled: boolean;
  // Relay Hosted: false until the device knows a restaurant that exists.
  hosted?: boolean;
  found?: boolean;
  signUpOpen?: boolean;
  trialDays?: number;
  // Relay Hosted: Relay's own terms (price, grace days, contact).
  platform?: { monthlyPrice: number; currency: string; graceDays: number; supportContact: string };
  restaurant?: RestaurantSummary | null;
  // For the privacy notice (Admin → Data & privacy).
  privacy?: { contact: string; retentionMonths: number };
  loginImages?: LoginImage[];
};

// The restaurant's name and logo from the last visit, so they show at once
// (and the logo starts loading) before the server answers.
const BRAND_KEY = 'relay.brand';
function rememberedBrand(): Pick<AppInfo, 'restaurantName' | 'restaurantLogo'> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(BRAND_KEY) || 'null');
    return saved && typeof saved.restaurantName === 'string' ? saved : null;
  } catch {
    return null;
  }
}
function rememberBrand({ restaurantName, restaurantLogo }: AppInfo) {
  try {
    localStorage.setItem(BRAND_KEY, JSON.stringify({ restaurantName, restaurantLogo }));
  } catch {
    // Private mode: nothing to remember.
  }
}

// The name to show for the app: the restaurant's, unless it is still the
// placeholder the server starts with.
export const restaurantTitle = (name?: string) => (name && name !== 'Restaurant' ? name : 'Relay');

// Only used until the server answers; real values come from Configuration.
const FALLBACK_INFO: AppInfo = {
  restaurantName: 'Relay',
  ...rememberedBrand(),
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
  // Relay Hosted: the restaurant this device signs in to ('' when none).
  restaurantCode: string;
  // Switches to another restaurant (or none) and reloads its sign-in details.
  chooseRestaurant: (code: string) => Promise<AppInfo>;
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
  const [code, setCode] = useState(restaurantCode);

  const loadInfo = useCallback(async (restaurant: string) => {
    const info: AppInfo = await Parse.Cloud.run('getAppInfo', restaurant ? { restaurant } : {});
    setAppInfo(info);
    if (info.found !== false) rememberBrand(info);
    return info;
  }, []);

  const chooseRestaurant = useCallback(
    async (next: string) => {
      const info = await loadInfo(next);
      const known = next && info.found !== false ? next : '';
      rememberRestaurant(known);
      setCode(known);
      return info;
    },
    [loadInfo],
  );

  useEffect(() => {
    loadInfo(code).catch((e) => setServerError(e instanceof Error ? e.message : String(e)));
    completeGoogleSignIn()
      .then((signedIn) => signedIn && setUserState(signedIn))
      .catch(() => undefined);
    // Once, for the restaurant known at start; chooseRestaurant reloads later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useCallback(async () => {
    await forgetPush();
    try {
      await Parse.User.logOut();
    } catch {
      // Session already invalid on the server; clearing it locally is enough.
    }
    try {
      for (const key of Object.keys(localStorage))
        if (key.startsWith('relay:profile:')) localStorage.removeItem(key);
    } catch {
      // Nothing cached.
    }
    setUserState(null);
    setProfile(null);
    setPreview(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoadingProfile(true);
    const cacheKey = `relay:profile:${user.id}`;
    try {
      const fresh: Profile = await Parse.Cloud.run('getMyProfile');
      setProfile(fresh);
      setError('');
      try {
        localStorage.setItem(cacheKey, JSON.stringify(fresh));
      } catch {
        // Storage full or blocked: the app still works online.
      }
    } catch (e) {
      // No connection: open with the last profile seen on this device, so the
      // app still starts offline (the screens show what they can).
      const offline =
        !navigator.onLine || (e instanceof Parse.Error && e.code === Parse.Error.CONNECTION_FAILED);
      let cached: Profile | null;
      try {
        cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      } catch {
        cached = null;
      }
      if (offline && cached) {
        setProfile(cached);
        setError('');
      } else if (e instanceof Parse.Error && e.code === Parse.Error.INVALID_SESSION_TOKEN) {
        await logout();
        // A sign-in past its days (S7) says so; a plain bad token does not.
        if (/expired/i.test(e.message)) setError(e.message);
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
    // Back online: load the account again (it may have changed).
    const onOnline = () => void refresh();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refresh]);

  const previewAvailable = PREVIEW_BUILD && appInfo.previewEnabled;
  const config = useMemo<AppConfig>(
    () =>
      profile?.config ?? {
        restaurantName: appInfo.restaurantName,
        restaurantLogo: appInfo.restaurantLogo,
        theme: appInfo.theme,
        currencySymbol: appInfo.currencySymbol,
        currencyCode: appInfo.currencyCode,
        timezone: appInfo.timezone,
        defaultDeliveryFee: 0,
        maxRiderFloat: 0,
        allowBatching: false,
        loginImages: appInfo.loginImages,
      },
    [profile, appInfo],
  );
  // The restaurant's colours, once the server has said what they are.
  const themeKnown = !!profile || appInfo !== FALLBACK_INFO;
  const { ink = '', accent = '' } = config.theme || {};
  useEffect(() => {
    if (themeKnown) applyTheme({ ink, accent });
  }, [themeKnown, ink, accent]);
  // The browser tab and the name iPhones give the home-screen app: the
  // restaurant's own name once it has one (Relay is only the software).
  const appName = restaurantTitle(config.restaurantName);
  useEffect(() => {
    document.title = appName;
    document
      .querySelector('meta[name="apple-mobile-web-app-title"]')
      ?.setAttribute('content', appName);
  }, [appName]);

  const value: Session = {
    status: loadingProfile ? 'loading' : 'ready',
    user,
    profile,
    appInfo,
    serverError,
    restaurantCode: code,
    chooseRestaurant,
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
  return role === 'admin' || role === 'finance'
    ? '/admin'
    : role === 'cashier'
      ? '/cashier'
      : '/rider';
}
