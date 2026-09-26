import { Bike } from 'lucide-react';
import embiroLogo from '../assets/embiro-logo.webp';

// App logo with the developer credit set directly under the word "Relay".
// `onDark` for the navy sidebar / sign-in story panel.
export function BrandMark({
  onDark = false,
  className = '',
}: {
  onDark?: boolean;
  className?: string;
}) {
  return (
    <div className={['brand-mark', onDark ? '' : 'dark', className].filter(Boolean).join(' ')}>
      <Bike aria-hidden />
      <div className="brand-text">
        <span className="brand-name">Relay</span>
        <span className="brand-credit">
          Powered by <img src={embiroLogo} alt="Embiro" width={52} height={17} />
        </span>
      </div>
    </div>
  );
}
