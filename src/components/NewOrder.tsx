import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Minus, Plus, Search, ShoppingBag } from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney } from '../lib/session';

type MenuItem = { id: string; title: string; category: string; price: number; color?: string };
const SAMPLE: MenuItem[] = [
  { id: '1', title: 'Smoky chicken bowl', category: 'Mains', price: 18500, color: '#f3b35b' },
  { id: '2', title: 'Beef rolex deluxe', category: 'Mains', price: 12000, color: '#d56b48' },
  { id: '3', title: 'Garden rice plate', category: 'Mains', price: 14500, color: '#90a95f' },
  { id: '4', title: 'Passion fruit juice', category: 'Drinks', price: 6000, color: '#efce58' },
  { id: '5', title: 'Iced hibiscus', category: 'Drinks', price: 5500, color: '#c75c66' },
  { id: '6', title: 'Breakfast chapati', category: 'Breakfast', price: 8000, color: '#d5a966' },
];
type Payload = {
  customerName: string;
  deliveryAddress: string;
  deliveryFee: number;
  items: { id: string; quantity: number }[];
};

export function NewOrder({
  onBack,
  onPlaced,
  preview,
}: {
  onBack: () => void;
  onPlaced: (total: number, payload: Payload) => Promise<void> | void;
  preview: boolean;
}) {
  const config = useConfig();
  const money = useMoney();
  const [items, setItems] = useState<MenuItem[]>(preview ? SAMPLE : []),
    [fee, setFee] = useState(preview ? 3000 : config.defaultDeliveryFee);
  const [category, setCategory] = useState('All'),
    [query, setQuery] = useState(''),
    [cart, setCart] = useState<Record<string, number>>({}),
    [name, setName] = useState(''),
    [address, setAddress] = useState(''),
    [placed, setPlaced] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (preview) return;
    Parse.Cloud.run('getOperationalMenu')
      .then((data: { items: MenuItem[]; deliveryFee: number }) => {
        setItems(data.items);
        setFee(data.deliveryFee);
      })
      .catch(() => setError('Menu could not be loaded. Please reconnect.'));
  }, [preview]);
  const filtered = items.filter(
    (i) =>
      (category === 'All' || i.category === category) &&
      i.title.toLowerCase().includes(query.toLowerCase()),
  );
  const subtotal = useMemo(
    () => items.reduce((sum, i) => sum + i.price * (cart[i.id] || 0), 0),
    [items, cart],
  );
  const count = Object.values(cart).reduce((a, b) => a + b, 0);
  const change = (id: string, d: number) =>
    setCart((prev) => ({ ...prev, [id]: Math.max(0, (prev[id] || 0) + d) }));
  const place = async () => {
    setSaving(true);
    setError('');
    try {
      await onPlaced(subtotal + fee, {
        customerName: name,
        deliveryAddress: address,
        deliveryFee: fee,
        items: Object.entries(cart)
          .filter(([, qty]) => qty > 0)
          .map(([id, quantity]) => ({ id, quantity })),
      });
      setPlaced(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not place order');
    } finally {
      setSaving(false);
    }
  };
  if (placed)
    return (
      <div className="success-state">
        <div className="success-check">
          <Check />
        </div>
        <p className="eyebrow">Ticket sent</p>
        <h2>Order placed.</h2>
        <p>The kitchen has received your order.</p>
        <button className="primary-button" onClick={onBack}>
          Back to dashboard <ArrowLeft />
        </button>
      </div>
    );
  return (
    <div className="order-page">
      <header className="order-head">
        <button className="icon-button" onClick={onBack} aria-label="Back">
          <ArrowLeft />
        </button>
        <div>
          <p className="eyebrow">New ticket</p>
          <h2>Create order</h2>
        </div>
        <span className="step-chip">01 / 02</span>
      </header>
      <section className="customer-grid">
        <label>
          Customer name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Start typing a name"
          />
        </label>
        <label>
          Delivery address
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street, area or landmark"
          />
        </label>
        <div className="channel-row">
          <span>Channel</span>
          <button className="active">Walk-in</button>
        </div>
      </section>
      <section className="menu-section">
        <div className="menu-tools">
          <div className="category-tabs">
            {['All', ...new Set(items.map((i) => i.category))].map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={category === c ? 'active' : ''}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="search">
            <Search />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an item"
            />
          </div>
        </div>
        <div className="menu-grid">
          {filtered.map((i) => (
            <article className="food-card" key={i.id}>
              <div className="food-art" style={{ background: i.color || '#819c72' }}>
                {i.title[0]}
              </div>
              <div className="food-info">
                <h3>{i.title}</h3>
                <p>{money(i.price)}</p>
              </div>
              {cart[i.id] ? (
                <div className="qty">
                  <button aria-label={`Remove ${i.title}`} onClick={() => change(i.id, -1)}>
                    <Minus />
                  </button>
                  <strong>{cart[i.id]}</strong>
                  <button aria-label={`Add ${i.title}`} onClick={() => change(i.id, 1)}>
                    <Plus />
                  </button>
                </div>
              ) : (
                <button
                  className="add-button"
                  aria-label={`Add ${i.title}`}
                  onClick={() => change(i.id, 1)}
                >
                  <Plus />
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
      <div className="cart-dock">
        <div className="cart-summary">
          <ShoppingBag />
          <span>{count} items</span>
          <strong>{money(subtotal + fee)}</strong>
        </div>
        <div className="commission">
          Delivery fee {money(fee)}
          {error && <span className="order-error"> · {error}</span>}
        </div>
        <button disabled={!count || !name.trim() || !address.trim() || saving} onClick={place}>
          {saving ? 'Sending…' : 'Place order'}
          <ArrowLeft className="arrow-forward" />
        </button>
      </div>
    </div>
  );
}
