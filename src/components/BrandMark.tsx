import embiroLogo from '../assets/embiro-logo-small.webp';
import { RelayMark } from './RelayMark';

// App logo: the mark and "Relay" on one line, the developer credit under
// them starting at the mark's left edge. `onDark` for the navy sidebar and
// sign-in story panel. The Embiro logo is inlined so it shows immediately,
// even on the loading screen.
//
// With `logo` (the restaurant's own, from Settings) the restaurant's logo is
// shown in its place; the favicon and installed-app icon stay Relay's.
export function BrandMark({
  onDark = false,
  className = '',
  logo = '',
  name = '',
}: {
  onDark?: boolean;
  className?: string;
  logo?: string;
  name?: string;
}) {
  if (logo)
    return (
      <div className={['brand-mark', 'restaurant-mark', className].filter(Boolean).join(' ')}>
        <img src={logo} alt={name} />
      </div>
    );
  return (
    <div className={['brand-mark', onDark ? '' : 'dark', className].filter(Boolean).join(' ')}>
      <div className="brand-row">
        <RelayMark />
        <span className="brand-name">Relay</span>
      </div>
      <span className="brand-credit">
        Powered by <img src={embiroLogo} alt="Embiro" width={52} height={17} />
      </span>
    </div>
  );
}
