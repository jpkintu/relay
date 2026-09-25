import { useCallback, useEffect, useState } from "react";
import {
  Bike,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  House,
  LogOut,
  Plus,
  UserRound,
  WalletCards,
} from "lucide-react";
import Parse from "../parse";
import { NewOrder } from "./NewOrder";
import { ShiftPanel } from './ShiftPanel'
type Props = { user: Parse.User | null; preview: boolean; onExit: () => void };
type Screen = "home" | "new" | "active" | "cash" | "earnings" | "profile";
type LiveOrder = { id:string; code:string; customer:string; status:string; total:number; cashStatus?:string; amountCollected?:number; commissionAmount?:number };
const money = (n: number) => `UGX ${n.toLocaleString()}`;
export function RiderWorkspace({ user, preview, onExit }: Props) {
  const [screen, setScreen] = useState<Screen>("home");
  const [orders, setOrders] = useState(0);
  const [liveOrders,setLiveOrders]=useState<LiveOrder[]>([]);
  const [loadError,setLoadError]=useState("");
  const loadOrders=useCallback(async()=>{
    try {
      if(preview){const rows:LiveOrder[]=await Parse.Cloud.run("getPreviewOrders");setLiveOrders(rows);setOrders(rows.length);return}
      if(!user)return;
      const q=new Parse.Query("Order");q.equalTo("createdBy",user);q.descending("createdAt");q.limit(100);
      const rows=await q.find();
      const mapped=rows.map(row=>({id:row.id!,code:row.get("orderCode"),customer:row.get("customerName"),status:row.get("status"),total:row.get("total"),cashStatus:row.get("cashStatus"),amountCollected:row.get("amountCollected"),commissionAmount:row.get("commissionAmount")}));
      setLiveOrders(mapped);setOrders(mapped.filter(row=>!["DELIVERED","CANCELLED"].includes(row.status)).length);setLoadError("");
    }catch(e){setLoadError(e instanceof Error?e.message:"Could not load orders")}
  },[preview,user?.id]);
  useEffect(()=>{void loadOrders();const timer=window.setInterval(()=>void loadOrders(),10000);return()=>window.clearInterval(timer)},[loadOrders]);
  if (screen === "new")
    return (
      <NewOrder
        preview={preview}
        onBack={() => setScreen("home")}
        onPlaced={async (_total, payload) => {
          if (user)
            await Parse.Cloud.run("createOrder", {
              ...payload,
              channel: "walkin",
              paymentMethod: "cash",
            });
          else if (preview)
            await Parse.Cloud.run("createPreviewOrder", payload);
          await loadOrders();
        }}
      />
    );
  if(screen!=="home") return <RiderSubPage screen={screen} orders={liveOrders} preview={preview} refresh={loadOrders} onBack={()=>setScreen("home")} onNavigate={setScreen} onExit={onExit}/>;
  return (
    <main className="rider-shell">
      <header className="rider-header">
        <div className="brand-mark dark">
          <Bike />
          <span>Relay</span>
        </div>
        <div className="shift-live">Rider workspace</div>
        <button className="avatar-button" aria-label="Profile">
          {(user?.get("name") || "AK").slice(0, 2).toUpperCase()}
        </button>
      </header>
      <div className="rider-content">
        <ShiftPanel kind="rider" preview={preview}/>
        <section className="welcome">
          <div>
            <p className="eyebrow">Tuesday · Rider R-014</p>
            <h1>
              Good afternoon,
              <br />
              <em>{user?.get("name") || "Amina"}.</em>
            </h1>
          </div>
          <button className="new-order-hero" onClick={() => setScreen("new")}>
            <span>
              <Plus />
            </span>
            <b>New order</b>
            <small>Start a delivery ticket</small>
            <ChevronRight />
          </button>
        </section>
        <section className="metric-grid">
          <article className="metric-card cash">
            <div className="metric-icon">
              <WalletCards />
            </div>
            <p>Cash on me</p>
            <strong>{money(preview?0:liveOrders.filter(o=>o.status==='DELIVERED'&&['WITH_RIDER','HANDOVER_PENDING'].includes(o.cashStatus||'')).reduce((sum,o)=>sum+(o.amountCollected||0),0))}</strong>
            <span className="limit">
              <i style={{ width: "34%" }} />
              34% of your limit
            </span>
            <button onClick={()=>setScreen("cash")}>
              View cash detail <ChevronRight />
            </button>
          </article>
          <article className="metric-card">
            <div className="metric-icon lime">
              <ClipboardList />
            </div>
            <p>Orders in flight</p>
            <strong>{orders}</strong>
            <span>{liveOrders.filter(o=>o.status==='READY').length} ready for pickup</span>
            <button onClick={()=>setScreen("active")}>
              Open active orders <ChevronRight />
            </button>
          </article>
          <article className="metric-card">
            <div className="metric-icon yellow">
              <CircleDollarSign />
            </div>
            <p>Today’s earnings</p>
            <strong>{money(liveOrders.filter(o=>o.status==='DELIVERED').reduce((sum,o)=>sum+(o.commissionAmount||0),0))}</strong>
            <span>{liveOrders.filter(o=>o.status==='DELIVERED').length} completed deliveries</span>
            <button onClick={()=>setScreen("earnings")}>
              View earnings <ChevronRight />
            </button>
          </article>
        </section>
        <section className="activity">
          {loadError&&<p className="ops-error">{loadError}</p>}
          <div className="section-title">
            <div>
              <p className="eyebrow">Now moving</p>
              <h2>Active orders</h2>
            </div>
            <button onClick={()=>setScreen("active")}>View all</button>
          </div>
          {liveOrders.filter(o=>!["DELIVERED","CANCELLED"].includes(o.status)).slice(0,5).map((o) => (
            <article className="order-row" key={o.code}>
              <div className={`status-dot ${o.status.toLowerCase()}`} />
              <div>
                <b>{o.code}</b>
                <span>{o.customer}</span>
              </div>
              <span className={`status-pill ${o.status.toLowerCase()}`}>
                {o.status}
              </span>
              <strong>{money(o.total)}</strong>
              <ChevronRight />
            </article>
          ))}
          {!orders&&<p className="empty-orders">No orders in flight. Start with a new order.</p>}
        </section>
      </div>
      <nav className="bottom-nav">
        {[
          [House, "Home"],
          [ClipboardList, "Active"],
          [Plus, "New order"],
          [CircleDollarSign, "Earnings"],
          [UserRound, "Profile"],
        ].map(([Icon, label], i) => {
          const C = Icon as typeof House;
          return (
            <button
              key={label as string}
              className={i === 0 ? "active" : i === 2 ? "center" : ""}
              onClick={() => setScreen((["home","active","new","earnings","profile"] as Screen[])[i])}
            >
              <C />
              <span>{label as string}</span>
            </button>
          );
        })}
        <button className="logout" onClick={onExit} aria-label="Log out">
          <LogOut />
        </button>
      </nav>
      {preview && (
        <div className="preview-ribbon">
          Live preview · changes are saved to demo data
        </div>
      )}
    </main>
  );
}

function RiderSubPage({screen,orders,preview,refresh,onBack,onNavigate,onExit}:{screen:Exclude<Screen,"home"|"new">;orders:LiveOrder[];preview:boolean;refresh:()=>Promise<void>;onBack:()=>void;onNavigate:(screen:Screen)=>void;onExit:()=>void}){
 const [selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const active=orders.filter(o=>!["DELIVERED","CANCELLED"].includes(o.status));
 const cash=orders.filter(o=>o.status==='DELIVERED'&&o.cashStatus==='WITH_RIDER');
 const earned=orders.filter(o=>o.status==='DELIVERED');
 const titles={active:"Active orders",cash:"My cash",earnings:"Earnings",profile:"Rider profile"};
 const transition=async(o:LiveOrder)=>{setBusy(true);setMessage("");try{await Parse.Cloud.run(preview?'transitionPreviewOrder':'transitionOrder',{orderId:o.id,action:o.status==='READY'?'pickup':'deliver',amountCollected:o.total});await refresh()}catch(e){setMessage(e instanceof Error?e.message:'Action failed')}finally{setBusy(false)}};
 const handover=async()=>{if(!selected.length)return;setBusy(true);setMessage("");try{await Parse.Cloud.run('createHandover',{orderIds:selected});setSelected([]);await refresh();setMessage('Handover sent. Waiting for cashier confirmation.')}catch(e){setMessage(e instanceof Error?e.message:'Handover failed')}finally{setBusy(false)}};
 return <main className="rider-shell"><header className="order-head"><button className="icon-button" onClick={onBack} aria-label="Back"><ChevronRight style={{transform:'rotate(180deg)'}}/></button><div><p className="eyebrow">Rider workspace</p><h2>{titles[screen]}</h2></div></header><div className="subpage-content">{message&&<p className="ops-error">{message}</p>}
 {screen==='active'&&<><div className="subpage-hero"><ClipboardList/><div><span>Orders in flight</span><strong>{active.length}</strong></div></div><div className="activity">{active.map(o=><article className="order-row actionable" key={o.id}><div className={`status-dot ${o.status.toLowerCase()}`}/><div><b>{o.code}</b><span>{o.customer}</span></div><span className="status-pill">{o.status}</span><strong>{money(o.total)}</strong>{['READY','PICKED_UP'].includes(o.status)?<button disabled={busy} onClick={()=>transition(o)}>{o.status==='READY'?'Pick up':'Deliver'}</button>:<ChevronRight/>}</article>)}{!active.length&&<p className="empty-orders">No active orders yet.</p>}</div></>}
 {screen==='cash'&&<><div className="cash-balance"><p>Cash awaiting handover</p><strong>{money(cash.reduce((sum,o)=>sum+(o.amountCollected||0),0))}</strong><span>{cash.length} delivered cash orders</span></div>{cash.map(o=><label className="cash-order" key={o.id}><input type="checkbox" checked={selected.includes(o.id)} onChange={()=>setSelected(p=>p.includes(o.id)?p.filter(id=>id!==o.id):[...p,o.id])}/><span>{o.code} · {o.customer}</span><b>{money(o.amountCollected||0)}</b></label>)}{cash.length>0&&<button className="handover-cta" disabled={busy||preview||!selected.length} onClick={handover}>Hand over {money(cash.filter(o=>selected.includes(o.id)).reduce((sum,o)=>sum+(o.amountCollected||0),0))} <ChevronRight/></button>}{preview&&<p className="info-card">Demo orders do not carry physical cash. Sign in as a rider to submit a real handover.</p>}</>}
 {screen==='earnings'&&<><div className="cash-balance earnings"><p>Commission earned</p><strong>{money(earned.reduce((sum,o)=>sum+(o.commissionAmount||0),0))}</strong><span>{earned.length} completed deliveries</span></div>{earned.map(o=><div className="cash-order" key={o.id}><span>{o.code} · {o.customer}</span><b>{money(o.commissionAmount||0)}</b></div>)}</>}
 {screen==='profile'&&<div className="profile-card"><div className="profile-avatar">R</div><h2>Rider profile</h2><p>Account and shift details are available after signing in.</p><button onClick={onExit}><LogOut/> {preview?'Sign in':'Log out'}</button></div>}</div><nav className="bottom-nav">{[[House,'Home','home'],[ClipboardList,'Active','active'],[Plus,'New order','new'],[CircleDollarSign,'Earnings','earnings'],[UserRound,'Profile','profile']].map(([Icon,label,target])=>{const C=Icon as typeof House;return <button className={screen===target?'active':target==='new'?'center':''} onClick={()=>onNavigate(target as Screen)} key={label as string}><C/><span>{label as string}</span></button>})}</nav></main>
}
