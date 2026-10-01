import { useEffect, useState } from 'react';
import Parse from '../parse';
import { useConfig } from '../lib/session';
import { formatDate } from '../lib/format';

// Owner: the cash drawer openings of the last 30 days, per person, with every
// opening without a sale (cloud/drawer.js → getDrawerOpenings).

type Openings = {
  items: { at: string; by: string; reason: string; label: string; note: string }[];
  people: { name: string; opens: number; noSale: number }[];
};

export function DrawerOpenings() {
  const { timezone } = useConfig();
  const [data, setData] = useState<Openings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    Parse.Cloud.run('getDrawerOpenings', {})
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [timezone]);
  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <p className="muted small">Loading drawer openings…</p>;
  const noSale = data.items.filter((item) => item.reason === 'no_sale');
  return (
    <div className="drawer-openings">
      <p className="setup-field-label">Drawer openings, last 30 days</p>
      {data.people.length === 0 ? (
        <p className="muted small">No openings recorded yet.</p>
      ) : (
        <ul className="muted small">
          {data.people.map((p) => (
            <li key={p.name}>
              <b>{p.name || 'Someone'}</b>: {p.opens} opening{p.opens === 1 ? '' : 's'}
              {p.noSale ? `, ${p.noSale} without a sale` : ''}
            </li>
          ))}
        </ul>
      )}
      {noSale.length > 0 && (
        <>
          <p className="setup-field-label">Without a sale</p>
          <ul className="small">
            {noSale.slice(0, 20).map((item) => (
              <li key={item.at}>
                {formatDate(item.at, timezone, { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                {item.by}: {item.note}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
