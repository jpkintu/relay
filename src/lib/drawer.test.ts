import { describe, expect, test } from 'vitest';
import { deviceFor, isCurrent, looksLikePrinter, pickAuto, type FoundDevice } from './drawer';

const usb: FoundDevice = {
  key: 'usb:04b8:0202:',
  mode: 'usb',
  label: 'EPSON TM-T20',
  printer: true,
  vendorId: 0x04b8,
  productId: 0x0202,
};
const keyboard: FoundDevice = { ...usb, key: 'usb:k', label: 'Keyboard', printer: false };
const net: FoundDevice = {
  key: 'bridge:192.168.1.50:9100',
  mode: 'bridge',
  label: 'Network printer at 192.168.1.50',
  printer: true,
  printerHost: '192.168.1.50',
  printerPort: 9100,
};

describe('finding the drawer printer', () => {
  test('a printer is the printer class or a receipt printer maker', () => {
    const printerClass = { interfaces: [{ alternates: [{ interfaceClass: 7 }] }] };
    const hid = { interfaces: [{ alternates: [{ interfaceClass: 3 }] }] };
    expect(looksLikePrinter({ vendorId: 0x1234, configurations: [printerClass] })).toBe(true);
    expect(looksLikePrinter({ vendorId: 0x04b8, configurations: [hid] })).toBe(true);
    expect(looksLikePrinter({ vendorId: 0x046d, configurations: [hid] })).toBe(false);
  });

  test('sets up a direct printer before a network one, never a non-printer', () => {
    expect(pickAuto([net, keyboard, usb])).toBe(usb);
    expect(pickAuto([keyboard, net])).toBe(net);
    expect(pickAuto([keyboard])).toBeUndefined();
  });

  test('using a found printer keeps the pin and the bridge address', () => {
    const before = { mode: 'off' as const, pin: 5 as const, bridgeUrl: 'http://127.0.0.1:9200' };
    const viaNet = deviceFor(before, net);
    expect(viaNet).toMatchObject({ mode: 'bridge', pin: 5, printerHost: '192.168.1.50' });
    expect(viaNet.bridgeUrl).toBe('http://127.0.0.1:9200');
    expect(isCurrent(viaNet, net)).toBe(true);
    expect(isCurrent(viaNet, usb)).toBe(false);
    expect(isCurrent(deviceFor(before, usb), usb)).toBe(true);
  });
});
