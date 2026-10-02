import { useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap, Marker } from 'leaflet';
import { Crosshair, MapPin, Navigation, X } from 'lucide-react';
import { useConfig } from '../lib/session';
import { loadOnce } from '../lib/lazy';

export type LatLng = { lat: number; lng: number };

const FALLBACK_CENTER: LatLng = { lat: 0.3476, lng: 32.5825 };

// Leaflet (~150 KB) and its CSS load with the first map, not with the app.
// After a new deploy, an open app reloads to the new version (lib/lazy.ts).
const loadLeaflet = loadOnce(() =>
  Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(
    ([module]) => (module as { default?: typeof import('leaflet') }).default ?? module,
  ),
);

// Directions in the phone's maps app (Google Maps on Android and in browsers).
export const directionsUrl = ({ lat, lng }: LatLng) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

// An OpenStreetMap map. `pin` shows a marker; with `onPick`, tapping the map
// or dragging the marker moves the pin.
export function MapView({
  center,
  pin,
  onPick,
  height = 220,
  zoom = 16,
  label,
}: {
  center: LatLng;
  pin: LatLng | null;
  onPick?: (next: LatLng) => void;
  height?: number;
  zoom?: number;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [failed, setFailed] = useState(false);
  const interactive = Boolean(onPick);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !box.current) return;
        const created = L.map(box.current, {
          center: pin ?? center,
          zoom,
          zoomControl: interactive,
          dragging: interactive,
          scrollWheelZoom: false,
          doubleClickZoom: interactive,
          touchZoom: interactive,
          boxZoom: false,
          keyboard: interactive,
          attributionControl: true,
        });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(created);
        if (interactive)
          created.on('click', (event) =>
            pick.current?.({ lat: event.latlng.lat, lng: event.latlng.lng }),
          );
        map.current = created;
        // Sized inside a sheet that may still be animating.
        window.setTimeout(() => created.invalidateSize(), 150);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
    // The map is created once; later center/pin changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker in step with `pin`.
  useEffect(() => {
    let cancelled = false;
    void loadLeaflet().then((L) => {
      const current = map.current;
      if (cancelled || !current) return;
      if (!pin) {
        marker.current?.remove();
        marker.current = null;
        return;
      }
      if (!marker.current) {
        const icon = L.divIcon({
          className: 'map-pin-icon',
          html: '<span></span>',
          iconSize: [30, 42],
          iconAnchor: [15, 40],
        });
        marker.current = L.marker(pin, { icon, draggable: interactive, keyboard: false }).addTo(
          current,
        );
        marker.current.on('dragend', () => {
          const at = marker.current?.getLatLng();
          if (at) pick.current?.({ lat: at.lat, lng: at.lng });
        });
      } else marker.current.setLatLng(pin);
      if (!current.getBounds().pad(-0.1).contains(pin)) current.panTo(pin);
    });
    return () => {
      cancelled = true;
    };
  }, [pin, interactive]);

  // Recentre when asked to (e.g. "Use my location").
  useEffect(() => {
    map.current?.setView(center, Math.max(map.current.getZoom(), zoom));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lat, center.lng]);

  return (
    <div className="map-view" style={{ height }} role="img" aria-label={label}>
      <div ref={box} className="map-canvas" />
      {failed && (
        <p className="muted small map-failed">The map could not load. Check the connection.</p>
      )}
    </div>
  );
}

// Asks the phone where it is.
function locate(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device cannot share its location'));
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) =>
        reject(
          new Error(
            error.code === error.PERMISSION_DENIED
              ? 'Location is blocked. Allow it for this site in the browser settings'
              : 'Could not find your location. Try again outside or tap the map',
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

// Full-screen sheet to drop or move a delivery pin.
export function PinSheet({
  title,
  initial,
  onSave,
  onClose,
  startWithMyLocation = false,
  around,
  hint = 'Tap the map where the customer is, or drag the pin.',
}: {
  title: string;
  initial: LatLng | null;
  onSave: (pin: LatLng | null) => Promise<void> | void;
  onClose: () => void;
  startWithMyLocation?: boolean;
  // Where the map opens without a pin (default: the restaurant or branch).
  around?: LatLng | null;
  hint?: string;
}) {
  const config = useConfig();
  const home = around ?? config.mapCenter ?? FALLBACK_CENTER;
  const [pin, setPin] = useState<LatLng | null>(initial);
  const [center, setCenter] = useState<LatLng>(initial ?? home);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');

  const findMe = async () => {
    setLocating(true);
    setError('');
    try {
      const here = await locate();
      setPin(here);
      setCenter(here);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not find your location');
    } finally {
      setLocating(false);
    }
  };
  useEffect(() => {
    if (startWithMyLocation && !initial) void findMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (value: LatLng | null) => {
    setBusy(true);
    setError('');
    try {
      await onSave(value);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the pin');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        className="sheet pin-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h2>{title}</h2>
            <p>{hint}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <MapView center={center} pin={pin} onPick={setPin} height={340} label={title} />
        <div className="pin-tools">
          <button
            type="button"
            className="setup-secondary"
            disabled={locating}
            onClick={() => void findMe()}
          >
            <Crosshair /> {locating ? 'Finding you…' : 'Use where I am now'}
          </button>
          {pin && (
            <span className="muted small">
              {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </span>
          )}
        </div>
        {error && <p className="ops-error">{error}</p>}
        <div className="pin-actions">
          <button className="primary-button" disabled={!pin || busy} onClick={() => void save(pin)}>
            <MapPin /> {busy ? 'Saving…' : 'Save pin'}
          </button>
          {initial && (
            <button className="setup-secondary" disabled={busy} onClick={() => void save(null)}>
              Remove pin
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

// A small map of a pinned address with a Directions button.
export function PinPreview({ location, label }: { location: LatLng; label: string }) {
  return (
    <div className="pin-preview">
      <MapView center={location} pin={location} height={170} zoom={16} label={label} />
      <a className="detail-link" href={directionsUrl(location)} target="_blank" rel="noreferrer">
        <Navigation size={16} /> Directions
      </a>
    </div>
  );
}
