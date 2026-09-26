import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Bike,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  House,
  LogOut,
  Plus,
  WalletCards,
} from 'lucide-react';
import Parse from '../parse';
import { NewOrder } from './NewOrder';
import { RiderEarnings } from './reports/RiderEarnings';
import { OrderDetail } from './OrderDetail';
import { ShiftPanel } from './ShiftPanel';
import { PoweredBy } from './PoweredBy';
import { useConfig, useMoney, useSession } from '../lib/session';
import { formatDate, greeting, initials, isToday } from '../lib/format';

type LiveOrder = {
  id: string;
  code: string;
  customer: string;
  status: string;
  total: number;
  cashStatus?: string;
  amountCollected?: number;
  commissionAmount?: number;
  deliveredAt?: Date;
};

type SubScreen = 'active' | 'cash' | 'earnings' | 'profile';

const IN_FLIGHT = (o: LiveOrder) => !['DELIVERED', 'CANCELLED'].includes(o.status);
const sum = (rows: LiveOrder[], pick: (o: LiveOrder) => number | undefined) =>
  rows.reduce((total, o) => total + (pick(o) || 0), 0);

export function RiderWorkspace() {
  const { user, preview } = useSession();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [loadError, setLoadError] = useState('');

  const loadOrders = useCallback(async () => {
    try {
      if (preview) {
        setOrders(await Parse.Cloud.run('getPreviewOrders'));
        return;
      }
      if (!user) return;
      const query = new Parse.Query('Order');
      query.equalTo('createdBy', user);
      query.descending('createdAt');
      query.limit(100);
      const rows = await query.find();
      setOrders(
        rows.map((row) => ({
          id: row.id!,
          code: row.get('orderCode'),
          customer: row.get('customerName'),
          status: row.get('status'),
          total: row.get('total'),
          cashStatus: row.get('cashStatus'),
          amountCollected: row.get('amountCollected'),
          commissionAmount: row.get('commissionAmount'),
          deliveredAt: row.get('deliveredAt'),
        })),
      );
      setLoadError('');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load orders');
    }
  }, [preview, user]);

  useEffect(() => {
    void loadOrders();
    const timer = window.setInterval(() => void loadOrders(), 10000);
    return () => window.clearInterval(timer);
  }, [loadOrders]);

  const subPage = (screen: SubScreen) => (
    <RiderSubPage screen={screen} orders={orders} refresh={loadOrders} />
  );
  return (
    <Routes>
      <Route index element={<RiderHome orders={orders} loadError={loadError} />} />
      <Route
        path="new"
        element={
          <NewOrder
            preview={preview}
            onBack={() => navigate('/rider')}
            onGoToCash={() => navigate('/rider/cash')}
            onOpenOrder={(id) => navigate(`/rider/order/${id}`)}
            onPlaced={async (payload) => {
              const result = await Parse.Cloud.run(
                preview ? 'createPreviewOrder' : 'createOrder',
                payload,
              );
              await loadOrders();
              return result;
            }}
          />
        }
      />
      <Route path="order/:orderId" element={<OrderRoute refresh={loadOrders} />} />
      <Route path="active" element={subPage('active')} />
      <Route path="cash" element={subPage('cash')} />
      <Route path="earnings" element={subPage('earnings')} />
      <Route path="profile" element={subPage('profile')} />
      <Route path="*" element={<Navigate to="/rider" replace />} />
    </Routes>
  );
}

function RiderHome({ orders, loadError }: { orders: LiveOrder[]; loadError: string }) {
  const { profile, preview, config } = useSession();
  const money = useMoney();
  const navigate = useNavigate();
  const name = profile?.name || (preview ? 'Preview rider' : 'Rider');
  const inFlight = orders.filter(IN_FLIGHT);
  const cashOnMe = preview
    ? 0
    : sum(
        orders.filter(
          (o) =>
            o.status === 'DELIVERED' &&
            ['WITH_RIDER', 'HANDOVER_PENDING'].includes(o.cashStatus || ''),
        ),
        (o) => o.amountCollected,
      );
  const limit = config.maxRiderFloat;
  const limitShare = limit > 0 ? Math.min(100, Math.round((cashOnMe / limit) * 100)) : 0;
  const deliveredToday = orders.filter(
    (o) => o.status === 'DELIVERED' && isToday(o.deliveredAt, config.timezone),
  );
  const weekday = formatDate(new Date(), config.timezone, { weekday: 'long' });

  return (
    <main className="rider-shell">
      <header className="rider-header">
        <div className="brand-mark dark">
          <Bike />
          <span>Relay</span>
        </div>
        <div className="shift-live">{config.restaurantName}</div>
        <button
          className="avatar-button"
          aria-label="Profile"
          onClick={() => navigate('/rider/profile')}
        >
          {initials(name)}
        </button>
      </header>
      <div className="rider-content">
        <ShiftPanel kind="rider" preview={preview} />
        <section className="welcome">
          <div>
            <p className="eyebrow">
              {weekday}
              {profile?.code ? ` · Rider ${profile.code}` : ''}
            </p>
            <h1>
              {greeting(config.timezone)},
              <br />
              <em>{name.split(' ')[0]}.</em>
            </h1>
          </div>
          <button className="new-order-hero" onClick={() => navigate('/rider/new')}>
            <span>
              <Plus />
            </span>
            <b>New order</b>
            <small>Start a delivery ticket</small>
            <ChevronRight />
          </button>
        </section>
        <section className="metric-grid">
          <article className="metric-card cash">
            <div className="metric-icon">
              <WalletCards />
            </div>
            <p>Cash on me</p>
            <strong>{money(cashOnMe)}</strong>
            <span className="limit">
              <i style={{ width: `${limitShare}%` }} />
              {limit > 0 ? `${limitShare}% of your ${money(limit)} limit` : 'No cash limit set'}
            </span>
            <button onClick={() => navigate('/rider/cash')}>
              View cash detail <ChevronRight />
            </button>
          </article>
          <article className="metric-card">
            <div className="metric-icon lime">
              <ClipboardList />
            </div>
            <p>Orders in flight</p>
            <strong>{inFlight.length}</strong>
            <span>{orders.filter((o) => o.status === 'READY').length} ready for pickup</span>
            <button onClick={() => navigate('/rider/active')}>
              Open active orders <ChevronRight />
            </button>
          </article>
          <article className="metric-card">
            <div className="metric-icon yellow">
              <CircleDollarSign />
            </div>
            <p>Today’s earnings</p>
            <strong>{money(sum(deliveredToday, (o) => o.commissionAmount))}</strong>
            <span>
              {deliveredToday.length} {deliveredToday.length === 1 ? 'delivery' : 'deliveries'}{' '}
              today
            </span>
            <button onClick={() => navigate('/rider/earnings')}>
              View earnings <ChevronRight />
            </button>
          </article>
        </section>
        <section className="activity">
          {loadError && <p className="ops-error">{loadError}</p>}
          <div className="section-title">
            <div>
              <p className="eyebrow">Now moving</p>
              <h2>Active orders</h2>
            </div>
            <button onClick={() => navigate('/rider/active')}>View all</button>
          </div>
          {inFlight.slice(0, 5).map((o) => (
            <article
              className="order-row clickable"
              key={o.id}
              role="button"
              tabIndex={0}
              onClick={() => !preview && navigate(`/rider/order/${o.id}`)}
            >
              <div className={`status-dot ${o.status.toLowerCase()}`} />
              <div>
                <b>{o.code}</b>
                <span>{o.customer}</span>
              </div>
              <span className={`status-pill ${o.status.toLowerCase()}`}>{o.status}</span>
              <strong>{money(o.total)}</strong>
              <ChevronRight />
            </article>
          ))}
          {!inFlight.length && (
            <p className="empty-orders">No orders in flight. Start with a new order.</p>
          )}
        </section>
      </div>
      <RiderNav />
      {preview && (
        <div className="preview-ribbon">Live preview · changes are saved to demo data</div>
      )}
    </main>
  );
}

const NAV_ITEMS = [
  [House, 'Home', '/rider'],
  [ClipboardList, 'Active', '/rider/active'],
  [Plus, 'New order', '/rider/new'],
  [WalletCards, 'Cash', '/rider/cash'],
  [CircleDollarSign, 'Earnings', '/rider/earnings'],
] as const;

function RiderNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map(([Icon, label, target]) => (
        <button
          key={label}
          className={
            pathname.replace(/\/$/, '') === target
              ? 'active'
              : target === '/rider/new'
                ? 'center'
                : ''
          }
          onClick={() => navigate(target)}
        >
          <Icon />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function commissionRule(
  commission: { type: string; perOrder: number; percent: number } | null | undefined,
  money: (n: number) => string,
) {
  if (!commission) return 'Not set';
  if (commission.type === 'percent') return `${commission.percent}% of each order subtotal`;
  if (commission.type === 'hybrid')
    return `${money(commission.perOrder)} + ${commission.percent}% of each order subtotal`;
  return `${money(commission.perOrder)} per delivery`;
}

const TITLES: Record<SubScreen, string> = {
  active: 'Active orders',
  cash: 'My cash',
  earnings: 'Earnings',
  profile: 'Rider profile',
};

function OrderRoute({ refresh }: { refresh: () => Promise<void> }) {
  const { orderId = '' } = useParams();
  const navigate = useNavigate();
  return <OrderDetail orderId={orderId} onBack={() => navigate(-1)} onChanged={refresh} />;
}

function RiderSubPage({
  screen,
  orders,
  refresh,
}: {
  screen: SubScreen;
  orders: LiveOrder[];
  refresh: () => Promise<void>;
}) {
  const { preview, profile, logout } = useSession();
  const money = useMoney();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = orders.filter(IN_FLIGHT);
  const cash = orders.filter((o) => o.status === 'DELIVERED' && o.cashStatus === 'WITH_RIDER');
  const earned = orders.filter((o) => o.status === 'DELIVERED');

  const { requireCashierConfirmForPickup } = useConfig();
  const pickup = async (o: LiveOrder) => {
    setBusy(true);
    setMessage('');
    try {
      await Parse.Cloud.run(preview ? 'transitionPreviewOrder' : 'transitionOrder', {
        orderId: o.id,
        action: 'pickup',
      });
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };
  const handover = async () => {
    if (!selected.length) return;
    setBusy(true);
    setMessage('');
    try {
      await Parse.Cloud.run('createHandover', { orderIds: selected });
      setSelected([]);
      await refresh();
      setMessage('Handover sent. Waiting for cashier confirmation.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Handover failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="rider-shell">
      <header className="order-head">
        <button className="icon-button" onClick={() => navigate('/rider')} aria-label="Back">
          <ChevronRight style={{ transform: 'rotate(180deg)' }} />
        </button>
        <div>
          <p className="eyebrow">Rider workspace</p>
          <h2>{TITLES[screen]}</h2>
        </div>
      </header>
      <div className="subpage-content">
        {message && <p className="ops-error">{message}</p>}
        {screen === 'active' && (
          <>
            <div className="subpage-hero">
              <ClipboardList />
              <div>
                <span>Orders in flight</span>
                <strong>{active.length}</strong>
              </div>
            </div>
            <div className="activity">
              {active.map((o) => (
                <article
                  className="order-row actionable clickable"
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => !preview && navigate(`/rider/order/${o.id}`)}
                >
                  <div className={`status-dot ${o.status.toLowerCase()}`} />
                  <div>
                    <b>{o.code}</b>
                    <span>{o.customer}</span>
                  </div>
                  <span className="status-pill">{o.status}</span>
                  <strong>{money(o.total)}</strong>
                  {o.status === 'READY' && (preview || !requireCashierConfirmForPickup) ? (
                    <button
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void pickup(o);
                      }}
                    >
                      Pick up
                    </button>
                  ) : o.status === 'PICKED_UP' && !preview ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/rider/order/${o.id}`);
                      }}
                    >
                      Deliver
                    </button>
                  ) : (
                    <ChevronRight />
                  )}
                </article>
              ))}
              {!active.length && <p className="empty-orders">No active orders yet.</p>}
            </div>
          </>
        )}
        {screen === 'cash' && (
          <>
            <div className="cash-balance">
              <p>Cash awaiting handover</p>
              <strong>{money(sum(cash, (o) => o.amountCollected))}</strong>
              <span>{cash.length} delivered cash orders</span>
            </div>
            {cash.map((o) => (
              <label className="cash-order" key={o.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(o.id)}
                  onChange={() =>
                    setSelected((p) =>
                      p.includes(o.id) ? p.filter((id) => id !== o.id) : [...p, o.id],
                    )
                  }
                />
                <span>
                  {o.code} · {o.customer}
                </span>
                <b>{money(o.amountCollected)}</b>
              </label>
            ))}
            {cash.length > 0 && (
              <button
                className="handover-cta"
                disabled={busy || preview || !selected.length}
                onClick={handover}
              >
                Hand over{' '}
                {money(
                  sum(
                    cash.filter((o) => selected.includes(o.id)),
                    (o) => o.amountCollected,
                  ),
                )}{' '}
                <ChevronRight />
              </button>
            )}
            {preview && (
              <p className="info-card">
                Demo orders do not carry physical cash. Sign in as a rider to submit a real
                handover.
              </p>
            )}
          </>
        )}
        {screen === 'earnings' &&
          (preview ? (
            <>
              <div className="cash-balance earnings">
                <p>Commission on recent deliveries</p>
                <strong>{money(sum(earned, (o) => o.commissionAmount))}</strong>
                <span>{earned.length} completed deliveries</span>
              </div>
              {earned.map((o) => (
                <div className="cash-order" key={o.id}>
                  <span>
                    {o.code} · {o.customer}
                  </span>
                  <b>{money(o.commissionAmount)}</b>
                </div>
              ))}
            </>
          ) : (
            <RiderEarnings />
          ))}
        {screen === 'profile' && (
          <div className="profile-card">
            <div className="profile-avatar">{initials(profile?.name || 'Rider')}</div>
            <h2>{profile?.name || 'Preview rider'}</h2>
            {profile ? (
              <>
                <p>
                  {profile.code && `${profile.code} · `}@{profile.username}
                  {profile.phone && ` · ${profile.phone}`}
                </p>
                <p>Commission: {commissionRule(profile.commission, money)}</p>
              </>
            ) : (
              <p>Account details are available after signing in.</p>
            )}
            <button onClick={() => void logout()}>
              <LogOut /> {preview ? 'Leave preview' : 'Log out'}
            </button>
            <PoweredBy />
          </div>
        )}
      </div>
      <RiderNav />
    </main>
  );
}
