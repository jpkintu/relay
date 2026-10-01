import net from 'node:net';
import { describe, expect, test } from 'vitest';
import { scan, subnetsOf } from './relay-print-bridge.mjs';

describe('print bridge', () => {
  test('looks in the /24 of each private IPv4 address only', () => {
    const subnets = subnetsOf({
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      wifi: [
        { family: 'IPv4', address: '192.168.1.23', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
      ],
      eth: [{ family: 'IPv4', address: '10.0.5.7', internal: false }],
      wan: [{ family: 'IPv4', address: '41.210.1.9', internal: false }],
    });
    expect(subnets).toEqual(['192.168.1', '10.0.5']);
  });

  test('finds a printer listening on the network', async () => {
    const printer = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => printer.listen(0, '127.0.0.2', resolve));
    const { port } = printer.address();
    try {
      const found = await scan({ subnets: ['127.0.0'], ports: [port], timeout: 300 });
      expect(found).toContainEqual({ host: '127.0.0.2', port });
      expect(found.some((p) => p.host === '127.0.0.3')).toBe(false);
    } finally {
      printer.close();
    }
  });
});
