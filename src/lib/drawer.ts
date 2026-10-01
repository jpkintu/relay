import Parse from '../parse';
import { printHtml } from './print';

// The cash drawer at the counter. A drawer is plugged into the receipt
// printer (its "DK" port) and opens when the printer sends it a pulse. Each
// till device says how its printer is reached (stored on the device):
//
// - printer: the printer's own driver opens the drawer whenever something
//   prints (Windows, Android POS printers: "open cash drawer" in the driver's
//   settings). A no-sale opening prints a small "No sale" slip.
// - usb: a USB receipt printer used directly from Chrome (WebUSB). Best on
//   Android POS terminals; on Windows the printer needs the WinUSB driver.
// - serial: a serial or USB-serial printer from Chrome or Edge (Web Serial).
// - bridge: a network (Wi-Fi or Ethernet) printer, through the Relay print
//   bridge running on the till computer (tools/print-bridge).
//
// The opening is then recorded on the server (logDrawerOpen).

export type DrawerMode = 'off' | 'printer' | 'usb' | 'serial' | 'bridge';
export type DrawerDevice = {
  mode: DrawerMode;
  // Which drawer connector pin (most drawers: pin 2).
  pin: 2 | 5;
  // usb / serial: the printer chosen on this device.
  vendorId?: number;
  productId?: number;
  // bridge: where the bridge runs, and the printer's address.
  bridgeUrl?: string;
  printerHost?: string;
  printerPort?: number;
};
export type DrawerReason = 'sale' | 'payment' | 'handover' | 'payout' | 'shift' | 'no_sale';

const KEY = 'relay:drawer';
export const DEFAULT_BRIDGE = 'http://127.0.0.1:9101';

export function loadDevice(): DrawerDevice {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved.mode === 'string') return { pin: 2, ...saved };
  } catch {
    // No saved setting on this device.
  }
  return { mode: 'off', pin: 2 };
}
export function saveDevice(device: DrawerDevice) {
  try {
    localStorage.setItem(KEY, JSON.stringify(device));
  } catch {
    // Private windows may refuse; the setting then lasts for this visit.
  }
}

// ESC p m t1 t2: pulse on connector pin 2 (m = 0) or pin 5 (m = 1), 50 ms on,
// 500 ms off. Every ESC/POS receipt printer understands it.
export const kickBytes = (pin: 2 | 5 = 2) =>
  new Uint8Array([0x1b, 0x70, pin === 5 ? 1 : 0, 0x19, 0xfa]);

// What this browser can do.
type UsbDevice = {
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  // Available without opening the device.
  configurations?: { interfaces: { alternates: { interfaceClass: number }[] }[] }[];
  open: () => Promise<void>;
  close: () => Promise<void>;
  selectConfiguration: (n: number) => Promise<void>;
  claimInterface: (n: number) => Promise<void>;
  transferOut: (endpoint: number, data: Uint8Array) => Promise<unknown>;
  configuration: {
    interfaces: {
      interfaceNumber: number;
      alternate: { endpoints: { direction: string; type: string; endpointNumber: number }[] };
    }[];
  } | null;
};
type SerialPortLike = {
  getInfo: () => { usbVendorId?: number; usbProductId?: number };
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  writable: WritableStream<Uint8Array> | null;
};
type Events = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};
const nav = () =>
  navigator as Navigator & {
    usb?: Events & {
      requestDevice: (o: { filters: object[] }) => Promise<UsbDevice>;
      getDevices: () => Promise<UsbDevice[]>;
    };
    serial?: Events & {
      requestPort: (o?: { filters: object[] }) => Promise<SerialPortLike>;
      getPorts: () => Promise<SerialPortLike[]>;
    };
  };
export const supports = {
  usb: () => typeof navigator !== 'undefined' && !!nav().usb,
  serial: () => typeof navigator !== 'undefined' && !!nav().serial,
};

// Receipt printer makers, by USB vendor id: the browser's list shows their
// printers (and any device of the USB printer class) first.
export const PRINTER_VENDORS: Record<number, string> = {
  0x04b8: 'Epson',
  0x0519: 'Star',
  0x1504: 'Bixolon',
  0x1d90: 'Citizen',
  0x154f: 'SNBC',
  0x0fe6: 'Rongta / ICS',
  0x0416: 'Winbond (Xprinter, Gprinter)',
  0x0483: 'STMicro (POS printer)',
  0x1fc9: 'NXP (POS printer)',
  0x28e9: 'GigaDevice (POS printer)',
  0x6868: 'POS printer',
  0x20d1: 'Rongta',
  0x0dd4: 'Custom',
  0x0a5f: 'Zebra',
  0x2730: 'Citizen',
  0x1a86: 'QinHeng (USB-serial)',
  0x067b: 'Prolific (USB-serial)',
  0x0403: 'FTDI (USB-serial)',
  0x10c4: 'Silicon Labs (USB-serial)',
};
const USB_PRINTER_CLASS = 7;
const hex = (n?: number) => (n ?? 0).toString(16).padStart(4, '0');

// Whether a USB device looks like a printer: the printer class on one of its
// interfaces, or a receipt printer maker.
export function looksLikePrinter(d: Pick<UsbDevice, 'vendorId' | 'configurations'>) {
  const printerClass = (d.configurations || []).some((c) =>
    c.interfaces.some((i) => i.alternates.some((a) => a.interfaceClass === USB_PRINTER_CLASS)),
  );
  return printerClass || d.vendorId in PRINTER_VENDORS;
}
const usbLabel = (d: UsbDevice) =>
  [d.manufacturerName || PRINTER_VENDORS[d.vendorId], d.productName].filter(Boolean).join(' ') ||
  `USB device ${hex(d.vendorId)}:${hex(d.productId)}`;
const serialLabel = (info: { usbVendorId?: number; usbProductId?: number }) =>
  info.usbVendorId
    ? `${PRINTER_VENDORS[info.usbVendorId] || 'Serial printer'} (${hex(info.usbVendorId)}:${hex(
        info.usbProductId,
      )})`
    : 'Serial port (COM)';

// Choosing the printer (needs a click: the browser shows its own list).
// `all`: every USB device, not only the ones that look like printers.
export async function chooseUsbPrinter(device: DrawerDevice, all = false): Promise<DrawerDevice> {
  if (!nav().usb) throw new Error('This browser cannot use USB printers. Use Chrome or Edge.');
  const filters = all
    ? []
    : [
        { classCode: USB_PRINTER_CLASS },
        ...Object.keys(PRINTER_VENDORS).map((id) => ({ vendorId: Number(id) })),
      ];
  const chosen = await nav().usb!.requestDevice({ filters });
  return { ...device, mode: 'usb', vendorId: chosen.vendorId, productId: chosen.productId };
}
export async function chooseSerialPrinter(device: DrawerDevice): Promise<DrawerDevice> {
  if (!nav().serial)
    throw new Error('This browser cannot use serial printers. Use Chrome or Edge.');
  const port = await nav().serial!.requestPort();
  const info = port.getInfo();
  return { ...device, mode: 'serial', vendorId: info.usbVendorId, productId: info.usbProductId };
}

// ---- Finding devices ----
//
// Without a click, a browser only lists USB and serial devices this site was
// allowed to use before (or that were added once with "Add a USB printer").
// Network printers are found by the print bridge, which looks for printers
// answering on port 9100 on this computer's local network.

export type FoundDevice = {
  // Stable key for lists.
  key: string;
  mode: 'usb' | 'serial' | 'bridge';
  label: string;
  // usb: whether it looks like a receipt printer.
  printer: boolean;
  vendorId?: number;
  productId?: number;
  printerHost?: string;
  printerPort?: number;
};
export type Found = {
  devices: FoundDevice[];
  bridge: { running: boolean; version?: string; scanned?: boolean; error?: string };
};

async function fetchJson(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `Answered ${response.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Every printer this device can reach now. `scan`: ask the bridge to look
// for network printers (a few seconds).
export async function findDevices(
  options: { bridgeUrl?: string; scan?: boolean } = {},
): Promise<Found> {
  const devices: FoundDevice[] = [];
  const usb = nav().usb;
  if (usb) {
    const list = await usb.getDevices().catch(() => [] as UsbDevice[]);
    for (const d of list)
      devices.push({
        key: `usb:${hex(d.vendorId)}:${hex(d.productId)}:${d.serialNumber || ''}`,
        mode: 'usb',
        label: usbLabel(d),
        printer: looksLikePrinter(d),
        vendorId: d.vendorId,
        productId: d.productId,
      });
  }
  const serial = nav().serial;
  if (serial) {
    const ports = await serial.getPorts().catch(() => [] as SerialPortLike[]);
    ports.forEach((port, i) => {
      const info = port.getInfo();
      devices.push({
        key: `serial:${hex(info.usbVendorId)}:${hex(info.usbProductId)}:${i}`,
        mode: 'serial',
        label: serialLabel(info),
        printer: true,
        vendorId: info.usbVendorId,
        productId: info.usbProductId,
      });
    });
  }
  const base = options.bridgeUrl || DEFAULT_BRIDGE;
  const bridge: Found['bridge'] = { running: false };
  try {
    const status = await fetchJson(`${base}/status`, 1500);
    bridge.running = !!status.ok;
    bridge.version = status.version;
  } catch {
    // The bridge is not running on this computer.
  }
  if (bridge.running && options.scan) {
    try {
      const result = await fetchJson(`${base}/scan`, 15000);
      bridge.scanned = true;
      for (const p of result.printers || [])
        devices.push({
          key: `bridge:${p.host}:${p.port}`,
          mode: 'bridge',
          label: `Network printer at ${p.host}${p.port === 9100 ? '' : `:${p.port}`}`,
          printer: true,
          printerHost: p.host,
          printerPort: p.port,
        });
    } catch (e) {
      // An older bridge cannot look for printers.
      bridge.error =
        e instanceof Error && /404|Not found/i.test(e.message)
          ? 'Update the print bridge to let it find network printers.'
          : 'The print bridge could not look for printers.';
    }
  }
  return { devices, bridge };
}

// Whether `found` is the printer this device is set up with.
export function isCurrent(device: DrawerDevice, found: FoundDevice) {
  if (device.mode !== found.mode) return false;
  if (found.mode === 'bridge')
    return (
      device.printerHost === found.printerHost &&
      (device.printerPort || 9100) === (found.printerPort || 9100)
    );
  return device.vendorId === found.vendorId && device.productId === found.productId;
}

// The setting that uses `found`, keeping the drawer pin and bridge address.
export function deviceFor(device: DrawerDevice, found: FoundDevice): DrawerDevice {
  if (found.mode === 'bridge')
    return {
      ...device,
      mode: 'bridge',
      printerHost: found.printerHost,
      printerPort: found.printerPort || 9100,
    };
  return { ...device, mode: found.mode, vendorId: found.vendorId, productId: found.productId };
}

// The printer to set up by itself: the first receipt printer, preferring a
// direct USB or serial one over the network.
export function pickAuto(devices: FoundDevice[]): FoundDevice | undefined {
  const order = { usb: 0, serial: 1, bridge: 2 };
  return devices.filter((d) => d.printer).sort((a, b) => order[a.mode] - order[b.mode])[0];
}

// Whether this device was ever set up (choosing "no drawer" counts).
export function hasSavedDevice() {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

// Sets this device up by itself when it was never set up and a printer is
// found. Returns the printer used, if any.
export async function autoSetUp(options: { scan?: boolean } = {}) {
  if (hasSavedDevice()) return undefined;
  const device = loadDevice();
  const found = pickAuto((await findDevices({ bridgeUrl: device.bridgeUrl, ...options })).devices);
  if (!found || hasSavedDevice()) return undefined;
  saveDevice(deviceFor(device, found));
  return found;
}

// Calls `onChange` when a USB or serial device is plugged in or out.
export function watchDevices(onChange: () => void) {
  const targets = [nav().usb, nav().serial].filter(Boolean) as Events[];
  for (const t of targets) {
    t.addEventListener('connect', onChange);
    t.addEventListener('disconnect', onChange);
  }
  return () => {
    for (const t of targets) {
      t.removeEventListener('connect', onChange);
      t.removeEventListener('disconnect', onChange);
    }
  };
}

async function sendUsb(device: DrawerDevice, bytes: Uint8Array) {
  const usb = nav().usb;
  if (!usb) throw new Error('This browser cannot use USB printers');
  const list = await usb.getDevices();
  const printers = list.filter(looksLikePrinter);
  const printer =
    list.find((d) => d.vendorId === device.vendorId && d.productId === device.productId) ||
    (printers.length === 1 ? printers[0] : undefined);
  if (!printer) throw new Error('The USB printer is not connected. Choose it again.');
  await printer.open();
  try {
    if (!printer.configuration) await printer.selectConfiguration(1);
    const iface = printer.configuration!.interfaces.find((i) =>
      i.alternate.endpoints.some((e) => e.direction === 'out' && e.type === 'bulk'),
    );
    if (!iface) throw new Error('This USB device does not take print data');
    await printer.claimInterface(iface.interfaceNumber);
    const out = iface.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk')!;
    await printer.transferOut(out.endpointNumber, bytes);
  } finally {
    await printer.close().catch(() => undefined);
  }
}

async function sendSerial(device: DrawerDevice, bytes: Uint8Array) {
  const serial = nav().serial;
  if (!serial) throw new Error('This browser cannot use serial printers');
  const ports = await serial.getPorts();
  const port =
    ports.find((p) => {
      const info = p.getInfo();
      return info.usbVendorId === device.vendorId && info.usbProductId === device.productId;
    }) || (ports.length === 1 ? ports[0] : undefined);
  if (!port) throw new Error('The serial printer is not connected. Choose it again.');
  await port.open({ baudRate: 9600 });
  try {
    const writer = port.writable!.getWriter();
    await writer.write(bytes);
    writer.releaseLock();
  } finally {
    await port.close().catch(() => undefined);
  }
}

async function sendBridge(device: DrawerDevice, pin: 2 | 5) {
  if (!device.printerHost) throw new Error('Enter the printer address');
  const response = await fetch(`${device.bridgeUrl || DEFAULT_BRIDGE}/kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host: device.printerHost,
      port: device.printerPort || 9100,
      pin,
    }),
  }).catch(() => {
    throw new Error('The Relay print bridge is not running on this computer');
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(json.error || `The print bridge answered ${response.status}`);
  }
}

// A small slip that makes a printer whose driver opens the drawer do so.
async function noSaleSlip(width: number, who: string, note: string) {
  const at = new Date().toLocaleString();
  const safe = (text: string) =>
    text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  await printHtml(
    'No sale',
    width,
    `<div style="text-align:center;font-weight:700">NO SALE</div><div style="text-align:center">${safe(
      at,
    )}</div><div style="text-align:center">${safe(who)}</div>${
      note ? `<div style="text-align:center">${safe(note)}</div>` : ''
    }`,
  );
}

// Opens the drawer on this device. Throws when it could not reach it.
// `printing`: a receipt is printing anyway (the driver mode needs nothing
// more).
export async function kickDrawer(
  device: DrawerDevice,
  options: { printing?: boolean; width?: number; who?: string; note?: string } = {},
) {
  switch (device.mode) {
    case 'usb':
      return sendUsb(device, kickBytes(device.pin));
    case 'serial':
      return sendSerial(device, kickBytes(device.pin));
    case 'bridge':
      return sendBridge(device, device.pin);
    case 'printer':
      if (!options.printing)
        await noSaleSlip(options.width || 80, options.who || '', options.note || '');
      return undefined;
    default:
      throw new Error('No cash drawer is set up on this device');
  }
}

// Opens the drawer for a cash event and records it. Never throws: a drawer
// that does not open must not stop the sale (the cashier opens it by hand).
export async function openDrawer(
  reason: DrawerReason,
  options: {
    ref?: string;
    note?: string;
    pin?: string;
    printing?: boolean;
    width?: number;
    who?: string;
  } = {},
): Promise<{ opened: boolean; error?: string }> {
  const device = loadDevice();
  if (device.mode === 'off') return { opened: false };
  // The driver mode opens with the receipt; other events need no slip.
  const skipHardware = device.mode === 'printer' && reason !== 'no_sale' && !options.printing;
  try {
    if (!skipHardware) await kickDrawer(device, options);
  } catch (e) {
    return { opened: false, error: e instanceof Error ? e.message : 'The drawer did not open' };
  }
  try {
    await Parse.Cloud.run('logDrawerOpen', {
      reason,
      ref: options.ref,
      note: options.note,
      pin: options.pin,
    });
  } catch (e) {
    if (reason === 'no_sale')
      return { opened: true, error: e instanceof Error ? e.message : 'Not recorded' };
  }
  return { opened: !skipHardware };
}
