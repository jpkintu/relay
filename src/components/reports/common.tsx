import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Parse from '../../parse';
import { useConfig } from '../../lib/session';
import { PRESETS, formatChange, presetRange, rangeLabel, todayIn } from '../../lib/range';
import type { DateRange, Preset } from '../../lib/range';

export type Filters = {
  preset: Preset;
  from: string;
  to: string;
  riderId: string;
  method: '' | 'cash' | 'mobile_money';
};

export function useFilters(preset: Exclude<Preset, 'custom'>, riderId = '') {
  const { timezone } = useConfig();
  return useState<Filters>(() => ({
    preset,
    ...presetRange(preset, todayIn(timezone)),
    riderId,
    method: '',
  }));
}

// Cloud function params for the current filters.
export function filterParams(filters: Filters, extra: Record<string, unknown> = {}) {
  return {
    from: filters.from,
    to: filters.to,
    ...(filters.riderId ? { riderId: filters.riderId } : {}),
    ...(filters.method ? { method: filters.method } : {}),
    ...extra,
  };
}

// Runs a Cloud function whenever its params change. Keeps the previous data
// while reloading, so tables and charts don't jump.
export function useCloud<T>(name: string, params: Record<string, unknown>, enabled = true) {
  const key = JSON.stringify(params);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    Parse.Cloud.run(name, JSON.parse(key))
      .then((result: T) => {
        if (cancelled) return;
        setData(result);
        setError('');
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [name, key, enabled, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}

export type RiderOption = { id: string; label: string; active: boolean };

export function useRiderOptions(enabled = true) {
  const { data } = useCloud<{ riders: RiderOption[] }>('getReportOptions', {}, enabled);
  return data?.riders ?? [];
}

export function FilterBar({
  filters,
  onChange,
  riders,
  showMethod,
  presets = PRESETS.map(([id]) => id),
  children,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  riders?: RiderOption[];
  showMethod?: boolean;
  presets?: readonly Exclude<Preset, 'custom'>[];
  children?: ReactNode;
}) {
  const { timezone } = useConfig();
  const today = todayIn(timezone);
  const setPreset = (preset: Preset) =>
    onChange(
      preset === 'custom'
        ? { ...filters, preset }
        : { ...filters, preset, ...presetRange(preset, today) },
    );
  const setDay = (field: keyof DateRange, value: string) => {
    if (!value) return;
    const next = { ...filters, preset: 'custom' as const, [field]: value };
    if (next.from > next.to) {
      if (field === 'from') next.to = value;
      else next.from = value;
    }
    onChange(next);
  };
  return (
    <div className="filter-bar" role="search">
      <label>
        <span>Dates</span>
        <select
          aria-label="Dates"
          value={filters.preset}
          onChange={(e) => setPreset(e.target.value as Preset)}
        >
          {PRESETS.filter(([id]) => presets.includes(id)).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
          <option value="custom">Custom dates</option>
        </select>
      </label>
      {filters.preset === 'custom' ? (
        <>
          <label>
            <span>From</span>
            <input
              aria-label="From"
              type="date"
              value={filters.from}
              max={today}
              onChange={(e) => setDay('from', e.target.value)}
            />
          </label>
          <label>
            <span>To</span>
            <input
              aria-label="To"
              type="date"
              value={filters.to}
              max={today}
              onChange={(e) => setDay('to', e.target.value)}
            />
          </label>
        </>
      ) : (
        <p className="filter-range">{rangeLabel(filters)}</p>
      )}
      {riders && (
        <label>
          <span>Rider</span>
          <select
            aria-label="Rider"
            value={filters.riderId}
            onChange={(e) => onChange({ ...filters, riderId: e.target.value })}
          >
            <option value="">All riders</option>
            {riders.map((rider) => (
              <option key={rider.id} value={rider.id}>
                {rider.label}
                {rider.active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </label>
      )}
      {showMethod && (
        <div className="filter-toggle" role="group" aria-label="Payment type">
          {(
            [
              ['', 'All'],
              ['cash', 'Cash'],
              ['mobile_money', 'Mobile money'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value || 'all'}
              className={filters.method === value ? 'active' : ''}
              aria-pressed={filters.method === value}
              onClick={() => onChange({ ...filters, method: value })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

// A labelled number with an optional change against the previous period.
export function Stat({
  label,
  value,
  note,
  change,
  goodWhenUp = true,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  change?: number | null;
  goodWhenUp?: boolean;
}) {
  const direction = change ? (change > 0 === goodWhenUp ? 'good' : 'bad') : '';
  return (
    <article className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {change !== undefined && change !== null && (
        <small className={`delta ${direction}`}>
          {change > 0 ? '▲' : change < 0 ? '▼' : '•'} {formatChange(change)} vs previous period
        </small>
      )}
      {note && <small>{note}</small>}
    </article>
  );
}

export function downloadCsv(name: string, columns: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const content = [columns, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
