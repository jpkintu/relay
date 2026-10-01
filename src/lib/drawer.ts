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
const nav = () =>
  navigator as Navigator & {
    usb?: {
      requestDevice: (o: { filters: object[] }) => Promise<UsbDevice>;
      getDevices: () => Promise<UsbDevice[]>;
    };
    serial?: {
      requestPort: () => Promise<SerialPortLike>;
      getPorts: () => Promise<SerialPortLike[]>;
    };
  };
export const supports = {
  usb: () => typeof navigator !== 'undefined' && !!nav().usb,
  serial: () => typeof navigator !== 'undefined' && !!nav().serial,
};

// Choosing the printer (needs a click: the browser shows its own list).
export async function chooseUsbPrinter(device: DrawerDevice): Promise<DrawerDevice> {
  if (!nav().usb) throw new Error('This browser cannot use USB printers. Use Chrome or Edge.');
  const chosen = await nav().usb!.requestDevice({ filters: [] });
  return { ...device, mode: 'usb', vendorId: chosen.vendorId, productId: chosen.productId };
}
export async function chooseSerialPrinter(device: DrawerDevice): Promise<DrawerDevice> {
  if (!nav().serial)
    throw new Error('This browser cannot use serial printers. Use Chrome or Edge.');
  const port = await nav().serial!.requestPort();
  const info = port.getInfo();
  return { ...device, mode: 'serial', vendorId: info.usbVendorId, productId: info.usbProductId };
}

async function sendUsb(device: DrawerDevice, bytes: Uint8Array) {
  const usb = nav().usb;
  if (!usb) throw new Error('This browser cannot use USB printers');
  const printer = (await usb.getDevices()).find(
    (d) => d.vendorId === device.vendorId && d.productId === device.productId,
  );
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
