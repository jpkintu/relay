import { useEffect, useRef, useState } from 'react';
import Parse, { LIVE_ENABLED } from '../parse';

// Live updates: subscribes to changes on the given classes (LiveQuery) and
// calls `refresh` when one happens, so boards, badges and the bell update at
// once. The server's ACLs decide what each person is told about (see the
// "live updates" e2e tests). Polling stays as a safety net: every `fastMs`
// while live updates are unavailable, every `slowMs` while they work.
type Options = { enabled?: boolean; fastMs?: number; slowMs?: number };

type Subscription = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  unsubscribe: () => void;
};

export function useLiveRefresh(
  classNames: string[],
  refresh: () => void,
  { enabled = true, fastMs = 10000, slowMs = 60000 }: Options = {},
) {
  const [live, setLive] = useState(false);
  const latest = useRef(refresh);
  latest.current = refresh;
  const key = classNames.join(',');

  useEffect(() => {
    if (!enabled || !LIVE_ENABLED || !Parse.User.current()) return;
    let stopped = false;
    let timer = 0;
    const subscriptions: Subscription[] = [];
    // Several changes usually arrive together (an order and its items):
    // refresh once for the batch.
    const changed = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => latest.current(), 300);
    };
    for (const className of key.split(',')) {
      new Parse.Query(className)
        .subscribe()
        .then((subscription) => {
          const sub = subscription as unknown as Subscription;
          if (stopped) {
            sub.unsubscribe();
            return;
          }
          subscriptions.push(sub);
          // Opened (or re-opened after a dropped connection): catch up on
          // anything missed while disconnected.
          sub.on('open', () => {
            setLive(true);
            changed();
          });
          sub.on('close', () => setLive(false));
          sub.on('error', () => setLive(false));
          for (const event of ['create', 'update', 'enter', 'leave', 'delete'])
            sub.on(event, changed);
        })
        .catch(() => setLive(false));
    }
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      subscriptions.forEach((sub) => sub.unsubscribe());
      setLive(false);
    };
  }, [key, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => latest.current(), live ? slowMs : fastMs);
    // Coming back to the app: refresh straight away.
    const onVisible = () => document.visibilityState === 'visible' && latest.current();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, live, fastMs, slowMs]);

  return live;
}
