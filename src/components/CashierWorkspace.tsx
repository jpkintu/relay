import { useCallback, useEffect, useState } from "react";
import Parse from "../parse";
import { CashierHandovers } from './CashierHandovers'
import { ShiftPanel } from './ShiftPanel'
import {
  Bike,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  HandCoins,
  LogOut,
  Search,
  UtensilsCrossed,
  X,
} from "lucide-react";

type Ticket = {
  status?: string;
  id?: string;
  code: string;
  rider: string;
  customer: string;
  items: string;
  total: number;
  stage: "Incoming" | "Preparing" | "Ready";
};
const initial: Ticket[] = [
  {
    code: "ORD-0218",
    rider: "R-014 · Amina",
    customer: "Joel M.",
    items: "2× Chicken bowl · 1× Juice",
    total: 43000,
    stage: "Incoming",
  },
  {
    code: "ORD-0219",
    rider: "R-008 · Musa",
    customer: "Walk-in",
    items: "1× Beef rolex deluxe",
    total: 15000,
    stage: "Incoming",
  },
  {
    code: "ORD-0217",
    rider: "R-014 · Amina",
    customer: "Sarah N.",
    items: "2× Garden rice plate",
    total: 32000,
    stage: "Preparing",
  },
  {
    code: "ORD-0214",
    rider: "R-014 · Amina",
    customer: "Joseph K.",
    items: "1× Chicken bowl · 1× Hibiscus",
    total: 24500,
    stage: "Ready",
  },
];
const money = (n: number) => `UGX ${n.toLocaleString()}`;
export function CashierWorkspace({ onExit, preview = false }: { onExit: () => void; preview?: boolean }) {
  const [tickets, setTickets] = useState(initial);
  const [tab, setTab] = useState<"orders" | "handovers" | "shift">("orders");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      if (preview) {
        const rows = await Parse.Cloud.run("getPreviewOrders");
        setTickets(rows.map((row: {id:string;code:string;rider:string;customer:string;items:string;total:number;status:string}) => ({ ...row, stage: row.status === "PLACED" ? "Incoming" : row.status === "READY" ? "Ready" : "Preparing" })));
        return;
      }
      const query = new Parse.Query("Order");
      query.containedIn("status", ["PLACED", "ACCEPTED", "PREPARING", "READY"]);
      query.descending("createdAt"); query.limit(50);
      const rows = await query.find();
      setTickets(rows.map(row => ({ id: row.id, code: row.get("orderCode"), rider: row.get("createdBy")?.id || "Rider", customer: row.get("customerName"), items: "Items recorded on ticket", total: row.get("total"), status:row.get("status"), stage: row.get("status") === "PLACED" ? "Incoming" : row.get("status") === "READY" ? "Ready" : "Preparing" })));
    } catch { setError("Could not refresh the live board."); }
  }, [preview]);
  useEffect(() => { load(); const timer = window.setInterval(load, 10000); return () => window.clearInterval(timer); }, [load]);
  const move = async (ticket: Ticket, stage: Ticket["stage"] | null) => {
    const action = stage === "Preparing" ? (ticket.stage === "Incoming" ? "accept" : "prepare") : stage === "Ready" ? "ready" : ticket.stage === "Ready" ? "pickup" : null;
    if (ticket.id && action) { try { const fn=preview?"transitionPreviewOrder":"transitionOrder";if (ticket.status === "ACCEPTED" && stage === "Ready") await Parse.Cloud.run(fn, { orderId: ticket.id, action: "prepare" }); await Parse.Cloud.run(fn, { orderId: ticket.id, action }); } catch (reason) { setError(reason instanceof Error ? reason.message : "Action failed"); return; } }
    setTickets((p) =>
      stage
        ? p.map((t) => (t.code === ticket.code ? { ...t, stage, status: stage === 'Preparing' ? 'ACCEPTED' : stage.toUpperCase() } : t))
        : p.filter((t) => t.code !== ticket.code),
    );
  };
  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div className="brand-mark dark">
          <Bike />
          <span>Relay</span>
        </div>
        <nav>
          <button
            className={tab === "orders" ? "active" : ""}
            onClick={() => setTab("orders")}
          >
            <UtensilsCrossed />
            Kitchen board
          </button>
          <button
            className={tab === "handovers" ? "active" : ""}
            onClick={() => setTab("handovers")}
          >
            <HandCoins />
            Cash handovers <b>2</b>
          </button>
          <button className={tab==='shift'?'active':''} onClick={()=>setTab('shift')}><Clock3/>Shift</button>
        </nav>
        <div className="shift-live">Cashier workspace</div>
        <button className="icon-button" onClick={onExit} aria-label="Log out">
          <LogOut />
        </button>
      </header>
      {tab === "orders" ? (
        <div className="ops-content">
          {error && <div className="ops-error">{error}</div>}
          <div className="ops-title">
            <div>
              <p className="eyebrow">Live service</p>
              <h1>Kitchen board</h1>
            </div>
            <span>
              <Clock3 /> Refreshes every 10 seconds
            </span>
          </div>
          <div className="board-grid">
            {(["Incoming", "Preparing", "Ready"] as const).map((stage) => (
              <section className="board-column" key={stage}>
                <header>
                  <span className={`board-dot ${stage.toLowerCase()}`} />
                  <h2>{stage}</h2>
                  <b>{tickets.filter((t) => t.stage === stage).length}</b>
                </header>
                {tickets
                  .filter((t) => t.stage === stage)
                  .map((ticket) => (
                    <article className="ticket" key={ticket.code}>
                      <div className="ticket-top">
                        <b>{ticket.code}</b>
                        <span>{money(ticket.total)}</span>
                      </div>
                      <h3>{ticket.customer}</h3>
                      <p>{ticket.items}</p>
                      <small>{ticket.rider}</small>
                      <div className="ticket-actions">
                        {stage === "Incoming" && (
                          <>
                            <button className="reject" disabled title="Cancellation with reason is not available yet">
                              <X />
                              Reject
                            </button>
                            <button
                              onClick={() => move(ticket, "Preparing")}
                            >
                              <Check />
                              Accept
                            </button>
                          </>
                        )}
                        {stage === "Preparing" && (
                          <button onClick={() => move(ticket, "Ready")}>
                            Mark ready <ChevronRight />
                          </button>
                        )}
                        {stage === "Ready" && (
                          <button onClick={() => move(ticket, null)}>
                            <ClipboardCheck />
                            Hand to rider
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
              </section>
            ))}
          </div>
        </div>
      ) : tab === 'handovers' ? (
        <CashierHandovers preview={preview} />
      ) : (
        <div className="ops-content"><ShiftPanel kind="cashier" preview={preview}/></div>
      )}
    </main>
  );
}

