// Relay app mark: a delivery rider with a food backpack, on the orange tile.
// Drawn on a 64-unit grid; the same artwork is used for the PWA icons
// (public/icons) and the favicon.
export function RelayMark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`relay-mark ${className}`.trim()}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Relay"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="64" height="64" rx="14" fill="#f14c1d" />
      <g fill="none" stroke="#eef2fa" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="15" cy="46" r="8.5" strokeWidth="3.6" />
        <circle cx="49" cy="46" r="8.5" strokeWidth="3.6" />
        <path d="M15 46 L31 46 L27 34 M31 46 L44 34 L49 46" strokeWidth="2.8" />
        <path d="M38 22 L31 33" strokeWidth="5" />
        <path d="M38 23 L44 29 L47 32" strokeWidth="3.4" />
        <path d="M31 33 L39 38 L33 46" strokeWidth="3.6" />
      </g>
      <circle cx="42" cy="15" r="4.4" fill="#eef2fa" />
      <g transform="rotate(-12 24 22)">
        <rect x="15" y="12" width="18" height="18" rx="3.5" fill="#eef2fa" />
        <g stroke="#f14c1d" strokeWidth="1.8" strokeLinecap="round" fill="none">
          <path d="M21 16.5 V25.5 M19.5 16.5 V19.5 Q21 21 22.5 19.5 V16.5" />
          <path d="M27.5 16.5 Q25.5 18.5 26.5 21.5 H27.5 V25.5" />
        </g>
      </g>
    </svg>
  );
}
