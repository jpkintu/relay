import { useEffect, useRef, useState } from 'react';
import type { Config, Data, Layout } from 'plotly.js';

// Plotly.js is ~1 MB, so it loads on the first chart, not with the app.
type PlotlyModule = typeof import('plotly.js');
let plotly: Promise<PlotlyModule> | null = null;
const loadPlotly = () =>
  (plotly ??= import('plotly.js-basic-dist-min').then(
    (m) => ((m as { default?: PlotlyModule }).default ?? m) as PlotlyModule,
  ));

// Chart colors: Embiro blue and orange first, then the reference palette
// (validated for colour blindness on the light surface).
// Slots are assigned in this order and follow the entity, never its rank.
export const SERIES = ['#0751f0', '#f14c1d', '#1baf7a', '#eda100', '#e87ba4'];
// Diverging pair for growth: up is blue, down is red.
export const UP = '#0751f0';
export const DOWN = '#e34948';
const INK = '#4f5870';
const GRID = '#e8ecf3';
const FONT = "'DM Sans', system-ui, sans-serif";

const BASE_LAYOUT: Partial<Layout> = {
  margin: { l: 8, r: 12, t: 10, b: 8 },
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  font: { family: FONT, size: 12, color: INK },
  showlegend: false,
  dragmode: false,
  hovermode: 'closest',
  hoverlabel: {
    bgcolor: '#0b1633',
    bordercolor: '#0b1633',
    font: { family: FONT, color: '#ffffff', size: 13 },
  },
  xaxis: {
    automargin: true,
    fixedrange: true,
    gridcolor: GRID,
    linecolor: '#d8deea',
    zeroline: false,
    tickfont: { color: INK },
  },
  yaxis: {
    automargin: true,
    fixedrange: true,
    gridcolor: GRID,
    zeroline: false,
    rangemode: 'tozero',
    tickformat: '~s',
    tickfont: { color: INK },
  },
};

const CONFIG: Partial<Config> = {
  displayModeBar: false,
  responsive: true,
  locale: 'en',
};

export type ChartProps = {
  data: Data[];
  layout?: Partial<Layout>;
  height?: number;
  // Number of bar slots: bars are kept at most ~24px thick.
  bars?: number;
  horizontal?: boolean;
  label: string;
  busy?: boolean;
};

export function Chart({ data, layout, height = 260, bars, horizontal, label, busy }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !width) return;
    let cancelled = false;
    loadPlotly()
      .then((Plotly) => {
        if (cancelled) return;
        const slot = bars ? (horizontal ? (height - 12) / bars : (width - 70) / bars) : 0;
        const thickness = horizontal ? 20 : 24;
        const bargap = slot ? Math.min(0.85, Math.max(0.15, 1 - thickness / slot)) : undefined;
        // All zeros: keep the axis at 0-1 instead of Plotly's 0-0.5 "500m" ticks.
        const values = data.flatMap((trace) =>
          Array.from(
            ((trace as { x?: unknown; y?: unknown })[horizontal ? 'x' : 'y'] ??
              []) as ArrayLike<unknown>,
          ).map(Number),
        );
        const empty = values.length > 0 && values.every((v) => !v);
        const valueAxis = empty ? { range: [0, 1], tickvals: [0] } : {};
        const merged = {
          ...BASE_LAYOUT,
          ...layout,
          xaxis: { ...BASE_LAYOUT.xaxis, ...layout?.xaxis, ...(horizontal ? valueAxis : {}) },
          yaxis: { ...BASE_LAYOUT.yaxis, ...layout?.yaxis, ...(horizontal ? {} : valueAxis) },
          height,
          width,
          bargap,
          barcornerradius: 4,
        } as Partial<Layout>;
        return Plotly.react(el, data, merged, CONFIG);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [data, layout, height, width, bars, horizontal]);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el && plotly) void plotly.then((Plotly) => Plotly.purge(el));
    };
  }, []);

  return (
    <div className={busy ? 'chart busy' : 'chart'} role="img" aria-label={label}>
      <div ref={ref} style={{ minHeight: height }} />
      {failed && <p className="muted">Chart could not load. The table below has the numbers.</p>}
    </div>
  );
}
