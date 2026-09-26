import logo from '../assets/embiro-logo.webp';

// Developer credit: "Powered by" above the Embiro logo.
export function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <div className={`powered-by ${className}`.trim()}>
      <span>Powered by</span>
      <img src={logo} alt="Embiro Concepts" width={112} height={36} />
    </div>
  );
}
