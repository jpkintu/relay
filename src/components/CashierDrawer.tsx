import { useCallback, useEffect, useState } from 'react';
import Parse from '../parse';
import { useSession } from '../lib/session';
import { usePin } from '../lib/pin';
import {
  DEFAULT_BRIDGE,
  chooseSerialPrinter,
  chooseUsbPrinter,
  deviceFor,
  findDevices,
  hasSavedDevice,
  isCurrent,
  kickDrawer,
  loadDevice,
  pickAuto,
  saveDevice,
  supports,
  watchDevices,
  type DrawerDevice,
  type DrawerMode,
  type Found,
  type FoundDevice,
} from '../lib/drawer';

// Cashier → Drawer: how this till reaches its cash drawer, a test, and
// opening it without a sale (PIN and a reason; the owner is told).

const MODES: { mode: DrawerMode; title: string; detail: string; check?: () => boolean }[] = [
  {
    mode: 'printer',
    title: 'The receipt printer opens it',
    detail:
      'For Windows PCs and POS terminals whose printer driver has “Open cash drawer”: switch it on in the printer’s settings (Printer properties → Device settings / Cash drawer, or the POS terminal’s printer settings). The drawer then opens whenever a receipt prints; opening it without a sale prints a small “No sale” slip.',
  },
  {
    mode: 'usb',
    title: 'USB printer, from this browser',
    detail:
      'Chrome or Edge talk to the USB receipt printer directly. Best on Android POS terminals and tablets. On Windows the printer must use the WinUSB driver (Zadig), which stops other programs printing to it; prefer “The receipt printer opens it” there.',
    check: supports.usb,
  },
  {
    mode: 'serial',
    title: 'Serial or USB-serial printer, from this browser',
    detail:
      'For printers on a COM port (serial, or a USB cable that shows up as a COM port). Chrome or Edge on Windows, Mac, Linux or ChromeOS.',
    check: supports.serial,
  },
  {
    mode: 'bridge',
    title: 'Network printer (Relay print bridge)',
    detail:
      'For Wi-Fi or Ethernet printers. Run the Relay print bridge on this computer (ask your Relay contact or see tools/print-bridge), then enter the printer’s address from its self-test page.',
  },
];

export function CashierDrawer() {
  const { profile } = useSession();
  const withPin = usePin();
  const enabled = !!profile?.config.drawer;
  const [device, setDevice] = useState<DrawerDevice>(loadDevice);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const who = profile?.name || '';
  const width = profile?.config.receipt?.width || 80;

  const update = (next: DrawerDevice) => {
    setDevice(next);
    saveDevice(next);
    setDone('');
    setError('');
  };

  // Printers this device can reach, kept up to date as they are plugged in
  // or out. A till never set up uses the first receipt printer found.
  const [found, setFound] = useState<Found | null>(null);
  const [searching, setSearching] = useState(false);
  const search = useCallback(async (scan: boolean) => {
    setSearching(true);
    try {
      const result = await findDevices({ bridgeUrl: loadDevice().bridgeUrl, scan });
      setFound(result);
      const auto = pickAuto(result.devices);
      if (auto && !hasSavedDevice()) {
        const next = deviceFor(loadDevice(), auto);
        setDevice(next);
        saveDevice(next);
        setDone(`Found ${auto.label} and set it up. Press Test.`);
      }
    } finally {
      setSearching(false);
    }
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    void search(true);
    return watchDevices(() => void search(false));
  }, [enabled, search]);
  const use = (d: FoundDevice) => {
    update(deviceFor(device, d));
    setDone(`Using ${d.label}. Press Test.`);
  };

  const choose = async (mode: 'usb' | 'serial', all = false) => {
    setError('');
    try {
      update(
        mode === 'usb' ? await chooseUsbPrinter(device, all) : await chooseSerialPrinter(device),
      );
      setDone('Printer chosen. Press Test.');
      void search(false);
    } catch (e) {
      // Closing the browser's list is not an error worth showing.
      if (e instanceof Error && !/No device selected|No port selected|cancel/i.test(e.message))
        setError(e.message);
    }
  };
  const checkBridge = async () => {
    setError('');
    setDone('');
    try {
      const response = await fetch(`${device.bridgeUrl || DEFAULT_BRIDGE}/status`);
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error || 'No answer');
      setDone(`The print bridge ${json.version} is running.`);
    } catch {
      setError('The Relay print bridge is not running on this computer.');
    }
  };
  // Opening without a sale: the server checks the PIN and records it first.
  const open = async (reason: string) => {
    setError('');
    setDone('');
    setBusy(true);
    const ok = await withPin(
      'Open the cash drawer',
      async (pin) => {
        await Parse.Cloud.run('logDrawerOpen', { reason: 'no_sale', note: reason, pin });
        await kickDrawer(device, { width, who, note: reason });
      },
      'Opening the drawer without a sale is recorded and the owner is told.',
    );
    setBusy(false);
    if (ok) {
      setDone('Drawer opened.');
      setNote('');
    }
  };

  if (!enabled)
    return (
      <section className="admin-panel drawer-page">
        <h2>Cash drawer</h2>
        <p className="muted">
          The cash drawer is switched off. The owner switches it on in Admin → Settings → Cash
          drawer.
        </p>
      </section>
    );

  return (
    <div className="drawer-page">
      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>Open the drawer</h2>
            <p className="muted">
              It opens by itself for cash sales, handovers, payouts and the opening count. To open
              it without a sale, say why and enter your PIN.
            </p>
          </div>
        </div>
        <div className="drawer-open">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Why, e.g. change for the rider float"
            aria-label="Why the drawer is opened"
          />
          <button
            className="primary-button"
            disabled={busy || device.mode === 'off' || note.trim().length < 3}
            onClick={() => void open(note.trim())}
          >
            Open drawer
          </button>
        </div>
        {device.mode === 'off' && (
          <p className="muted small">Set up how this till reaches the drawer below first.</p>
        )}
        {error && <p className="form-error">{error}</p>}
        {done && <p className="form-success">{done}</p>}
      </section>

      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>This till</h2>
            <p className="muted">
              The drawer is plugged into the receipt printer. Choose how this device reaches the
              printer; each till keeps its own setting.
            </p>
          </div>
        </div>
        <div className="drawer-found">
          <div className="drawer-found-head">
            <b>Printers found</b>
            <button
              className="setup-secondary"
              disabled={searching}
              onClick={() => void search(true)}
            >
              {searching ? 'Looking…' : 'Look again'}
            </button>
          </div>
          {found && found.devices.length > 0 ? (
            <ul>
              {found.devices.map((d) => {
                const current = isCurrent(device, d);
                return (
                  <li key={d.key} className={current ? 'current' : ''}>
                    <span>
                      <b>{d.label}</b>
                      <small className="muted">
                        {d.mode === 'usb'
                          ? d.printer
                            ? 'USB printer'
                            : 'USB device (may not be a printer)'
                          : d.mode === 'serial'
                            ? 'Serial printer'
                            : 'Network printer, through the print bridge'}
                      </small>
                    </span>
                    {current ? (
                      <em>In use</em>
                    ) : (
                      <button className="setup-secondary" onClick={() => use(d)}>
                        Use this
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted small">
              {!found || searching
                ? 'Looking for printers…'
                : 'No printer found yet. Plug the printer in and switch it on, then add it below.'}
            </p>
          )}
          <p className="muted small">
            {found?.bridge.running
              ? `Print bridge ${found.bridge.version || ''} running on this computer${
                  found.bridge.scanned ? ': it looked for network printers.' : '.'
                }`
              : 'No print bridge on this computer: network printers cannot be found (see tools/print-bridge).'}
            {found?.bridge.error ? ` ${found.bridge.error}` : ''}
          </p>
          <div className="platform-actions">
            {supports.usb() && (
              <button className="setup-secondary" onClick={() => void choose('usb')}>
                Add a USB printer
              </button>
            )}
            {supports.serial() && (
              <button className="setup-secondary" onClick={() => void choose('serial')}>
                Add a serial printer
              </button>
            )}
            {supports.usb() && (
              <button className="link-button" onClick={() => void choose('usb', true)}>
                Not listed? Show every USB device
              </button>
            )}
          </div>
          <small className="muted">
            The browser asks once before Relay may use a USB or serial printer; after that it is
            found by itself whenever it is plugged in.
          </small>
        </div>

        <div className="drawer-modes" role="radiogroup" aria-label="How the drawer is connected">
          {MODES.map((m) => {
            const unavailable = m.check && !m.check();
            return (
              <label
                key={m.mode}
                className={`drawer-mode${device.mode === m.mode ? ' chosen' : ''}${
                  unavailable ? ' unavailable' : ''
                }`}
              >
                <input
                  type="radio"
                  name="drawer-mode"
                  checked={device.mode === m.mode}
                  disabled={unavailable}
                  onChange={() => update({ ...device, mode: m.mode })}
                />
                <span>
                  <b>{m.title}</b>
                  <small>
                    {unavailable ? 'This browser cannot do this; use Chrome or Edge. ' : ''}
                    {m.detail}
                  </small>
                </span>
              </label>
            );
          })}
          <label className={`drawer-mode${device.mode === 'off' ? ' chosen' : ''}`}>
            <input
              type="radio"
              name="drawer-mode"
              checked={device.mode === 'off'}
              onChange={() => update({ ...device, mode: 'off' })}
            />
            <span>
              <b>No drawer on this device</b>
              <small>For devices away from the counter.</small>
            </span>
          </label>
        </div>

        {(device.mode === 'usb' || device.mode === 'serial') && (
          <div className="drawer-settings">
            <button
              className="setup-secondary"
              onClick={() => void choose(device.mode as 'usb' | 'serial')}
            >
              {device.vendorId ? 'Choose another printer' : 'Choose the printer'}
            </button>
            {device.vendorId ? (
              <small className="muted">
                Printer {device.vendorId.toString(16).padStart(4, '0')}:
                {(device.productId || 0).toString(16).padStart(4, '0')}
              </small>
            ) : (
              <small className="muted">
                The browser shows the connected printers to pick from.
              </small>
            )}
          </div>
        )}
        {device.mode === 'bridge' && (
          <div className="drawer-settings platform-form">
            <label className="setup-field">
              Printer address
              <input
                value={device.printerHost || ''}
                onChange={(e) => update({ ...device, printerHost: e.target.value.trim() })}
                placeholder="e.g. 192.168.1.50"
              />
            </label>
            <label className="setup-field">
              Printer port
              <input
                inputMode="numeric"
                value={String(device.printerPort || 9100)}
                onChange={(e) => update({ ...device, printerPort: Number(e.target.value) || 9100 })}
              />
            </label>
            <label className="setup-field">
              Print bridge
              <input
                value={device.bridgeUrl || DEFAULT_BRIDGE}
                onChange={(e) => update({ ...device, bridgeUrl: e.target.value.trim() })}
              />
            </label>
            <div className="platform-actions">
              <button className="setup-secondary" onClick={() => void checkBridge()}>
                Check the bridge
              </button>
            </div>
          </div>
        )}
        {device.mode !== 'off' && device.mode !== 'printer' && (
          <label className="setup-field drawer-pin">
            Drawer connector
            <select
              value={device.pin}
              onChange={(e) => update({ ...device, pin: Number(e.target.value) === 5 ? 5 : 2 })}
            >
              <option value={2}>Pin 2 (most drawers)</option>
              <option value={5}>Pin 5</option>
            </select>
          </label>
        )}
        {device.mode !== 'off' && (
          <div className="platform-actions">
            <button
              className="setup-secondary"
              disabled={busy}
              onClick={() => void open('Testing the drawer')}
            >
              Test
            </button>
            <small className="muted">
              A test is an opening without a sale: it asks for your PIN.
            </small>
          </div>
        )}
      </section>
    </div>
  );
}
