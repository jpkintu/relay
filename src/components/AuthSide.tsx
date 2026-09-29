import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Banknote, Bike, ChefHat, LayoutDashboard } from 'lucide-react';
import { useSession } from '../lib/session';
import { BrandMark } from './BrandMark';

// The panel beside the sign-in form (and the account, paused and ended
// screens). The restaurant's own pictures (Admin → Branding) slide under a
// wash of its brand colour; without any, a short Relay introduction runs.

const SLIDE_MS = 6000;

type Slide = { key: string; image?: string; content: ReactNode };

const RELAY_SLIDES: Slide[] = [
  {
    key: 'hero',
    content: (
      <>
        <h1>
          From kitchen
          <br />
          to doorstep.
          <br />
          <em>Cash accounted.</em>
        </h1>
        <p>Orders, riders and every handover — connected in one fast operating system.</p>
      </>
    ),
  },
  {
    key: 'riders',
    content: (
      <Tip icon={<Bike size={26} />} step="Riders">
        Take an order at the door in seconds: pick the customer, add the dishes, and the price is
        worked out for you.
      </Tip>
    ),
  },
  {
    key: 'kitchen',
    content: (
      <Tip icon={<ChefHat size={26} />} step="Kitchen board">
        Cashiers see every new order at once, mark it ready, and hand it to the rider who took it.
      </Tip>
    ),
  },
  {
    key: 'cash',
    content: (
      <Tip icon={<Banknote size={26} />} step="Cash handovers">
        Riders hand over what they collected; the cashier counts it, and any shortfall is recorded
        against the orders it belongs to.
      </Tip>
    ),
  },
  {
    key: 'owner',
    content: (
      <Tip icon={<LayoutDashboard size={26} />} step="Owner">
        Sales, commission, the till and the audit trail in one place — from anywhere.
      </Tip>
    ),
  },
];

function Tip({ icon, step, children }: { icon: ReactNode; step: string; children: ReactNode }) {
  return (
    <div className="side-tip">
      <span className="side-tip-icon">{icon}</span>
      <p className="eyebrow">{step}</p>
      <p>{children}</p>
    </div>
  );
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function AuthSide() {
  const { appInfo, config } = useSession();
  const images = config.loginImages ?? appInfo.loginImages ?? [];
  const slides: Slide[] = images.length
    ? images.map((image, index) => ({
        key: `${index}:${image.url}`,
        image: image.url,
        content: image.caption ? <p className="side-caption">{image.caption}</p> : null,
      }))
    : RELAY_SLIDES;
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = slides.length;
  const shown = current % count;

  useEffect(() => {
    if (paused || count < 2 || prefersReducedMotion()) return;
    const timer = window.setInterval(() => setCurrent((index) => (index + 1) % count), SLIDE_MS);
    return () => window.clearInterval(timer);
  }, [paused, count]);

  return (
    <section
      className={`auth-story auth-side${images.length ? ' with-images' : ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {slides.map((slide, index) => (
        <div
          key={slide.key}
          className={`side-slide${index === shown ? ' shown' : ''}`}
          aria-hidden={index !== shown}
        >
          {slide.image && <img src={slide.image} alt="" loading={index ? 'lazy' : 'eager'} />}
        </div>
      ))}
      <BrandMark onDark />
      <div key={shown} className="story-copy side-copy" aria-live="polite">
        {slides[shown].content}
      </div>
      {count > 1 && (
        <div className="side-dots" role="tablist" aria-label="Slides">
          {slides.map((slide, index) => (
            <button
              key={slide.key}
              type="button"
              role="tab"
              aria-selected={index === shown}
              aria-label={`Slide ${index + 1} of ${count}`}
              className={index === shown ? 'active' : ''}
              onClick={() => setCurrent(index)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
