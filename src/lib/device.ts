import { useEffect, useState } from 'react';

// Screen classes used across the app. Keep in sync with the breakpoints in
// src/index.css ("Device breakpoints").
//   phone   < 600px    one column, bottom bars, full-width sheets
//   tablet  600–1023   two columns where it fits, admin menu in a drawer
//   laptop  1024–1599  full sidebar / three-column kitchen board
//   monitor ≥ 1600     wider content areas
export type Device = 'phone' | 'tablet' | 'laptop' | 'monitor';

export function deviceFor(width: number): Device {
  if (width < 600) return 'phone';
  if (width < 1024) return 'tablet';
  if (width < 1600) return 'laptop';
  return 'monitor';
}

const current = (): Device =>
  typeof window === 'undefined' ? 'laptop' : deviceFor(window.innerWidth);

// Current device class; updates on resize and rotation.
export function useDevice(): Device {
  const [device, setDevice] = useState<Device>(current);
  useEffect(() => {
    const update = () => setDevice(current());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return device;
}

// Mirrors the device class onto <html data-device="…"> for CSS and debugging.
export function useDeviceAttribute(): Device {
  const device = useDevice();
  useEffect(() => {
    document.documentElement.dataset.device = device;
  }, [device]);
  return device;
}
