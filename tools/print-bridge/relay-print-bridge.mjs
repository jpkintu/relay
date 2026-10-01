#!/usr/bin/env node
// Relay print bridge: lets the Relay app in the browser reach a network
// (Wi-Fi or Ethernet) receipt printer, to open the cash drawer plugged into
// it. Browsers cannot open raw printer connections themselves; this small
// program, running on the till computer, can.
//
//   node relay-print-bridge.mjs
//
// Settings (environment variables):
//   RELAY_ORIGIN   the address of your Relay app, e.g. https://relay.example
//                  (only pages from it may use the bridge; several: comma
//                  separated). Without it any page on this computer may.
//   BRIDGE_PORT    the port the bridge listens on (default 9101).
//
// It listens on this computer only (127.0.0.1) and only talks to printers on
// the local network (10.x, 172.16-31.x, 192.168.x addresses).

import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.BRIDGE_PORT || 9101);
const ORIGINS = String(process.env.RELAY_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const VERSION = '1.0.0';

// ESC p m t1 t2: a pulse on drawer pin 2 (m = 0) or 5 (m = 1).
const kick = (pin) => Buffer.from([0x1b, 0x70, Number(pin) === 5 ? 1 : 0, 0x19, 0xfa]);

const privateHost = (host) =>
  /^10\.\d+\.\d+\.\d+$/.test(host) ||
  /^192\.168\.\d+\.\d+$/.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
  host === '127.0.0.1' ||
  host === 'localhost';

function send(host, port, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: 5000 }, () => {
      socket.end(bytes, () => resolve());
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`No answer from the printer at ${host}:${port}`));
    });
    socket.on('error', (error) =>
      reject(new Error(`Could not reach the printer at ${host}:${port}: ${error.message}`)),
    );
  });
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = !ORIGINS.length || ORIGINS.includes(origin);
  if (allowed && origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome asks before a public page may call a program on this computer.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  return allowed;
}

const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') return reply(res, allowed ? 204 : 403, {});
  if (!allowed) return reply(res, 403, { error: 'This page may not use the print bridge' });
  if (req.method === 'GET' && req.url === '/status')
    return reply(res, 200, { ok: true, version: VERSION });
  if (req.method !== 'POST' || !['/kick', '/raw'].includes(req.url))
    return reply(res, 404, { error: 'Not found' });
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    try {
      const p = JSON.parse(body || '{}');
      const host = String(p.host || '').trim();
      const port = Number(p.port || 9100);
      if (!privateHost(host))
        return reply(res, 400, { error: 'Use the printer’s local network address' });
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return reply(res, 400, { error: 'Printer port: 1 to 65535 (usually 9100)' });
      // /raw: any ESC/POS bytes (base64), e.g. a receipt.
      const bytes = req.url === '/kick' ? kick(p.pin) : Buffer.from(String(p.data || ''), 'base64');
      await send(host, port, bytes);
      reply(res, 200, { ok: true });
    } catch (error) {
      reply(res, 502, { error: error.message });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Relay print bridge ${VERSION} on http://127.0.0.1:${PORT}`);
  if (!ORIGINS.length)
    console.log('Tip: set RELAY_ORIGIN to your Relay address so only Relay can use it.');
});
