# Relay print bridge

For a **network (Wi-Fi or Ethernet) receipt printer** with a cash drawer
plugged into it. The browser cannot talk to a network printer directly; this
small program on the till computer passes Relay's "open the drawer" on to it.

USB and serial printers do not need it (Relay reaches them from Chrome), nor
printers whose driver already opens the drawer when a receipt prints.

## Install (once, on the till computer)

1. Install Node.js 18 or newer from nodejs.org.
2. Copy `relay-print-bridge.mjs` to the computer.
3. Start it, with your Relay address:
   - Windows (Command Prompt): `set RELAY_ORIGIN=https://your-relay-address && node relay-print-bridge.mjs`
   - Mac / Linux: `RELAY_ORIGIN=https://your-relay-address node relay-print-bridge.mjs`
4. To start it with the computer: put the same command in a shortcut in the
   Startup folder (Windows: `shell:startup`), or a login item (Mac).

It listens on this computer only (`http://127.0.0.1:9101`) and only talks to
printers on the local network.

## In Relay

Cashier → **Drawer** → **Printers found**: with the bridge running, Relay
looks for network printers by itself (the bridge tries port 9100 on every
address of this computer's local network; it sends nothing, so nothing
prints). Press **Use this** next to the printer, then **Test**. A till that
was never set up uses the first printer found by itself.

If the printer is not found (another network, another port), choose
**Network printer (Relay print bridge)** and enter its address (printed on its
self-test page, e.g. `192.168.1.50`) and port (usually `9100`).

Chrome may ask once to allow the page to reach a device on the local network:
allow it.
