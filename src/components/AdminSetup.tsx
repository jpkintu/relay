import { useCallback, useEffect, useState } from "react";
import Parse from "../parse";

type Member = {
  id: string;
  name: string;
  username: string;
  phone: string;
  role: string;
  active: boolean;
  commissionType: string;
  commissionPerOrder: number;
  commissionPercent: number;
};
type Item = {
  id: string;
  title: string;
  price: number;
  category: string;
  active: boolean;
  availableToday: boolean;
};
type Category = {id:string;title:string;active:boolean};
type Settings = {
  restaurantName: string;
  currencySymbol: string;
  defaultDeliveryFee: number;
  maxRiderFloat: number;
  allowBatching: boolean;
};
const defaults: Settings = {
  restaurantName: "Restaurant",
  currencySymbol: "UGX",
  defaultDeliveryFee: 3000,
  maxRiderFloat: 200000,
  allowBatching: false,
};
const input = (
  label: string,
  value: string | number,
  onChange: (value: string) => void,
  type = "text",
) => (
  <label className="setup-field">
    {label}
    <input
      required
      value={value}
      type={type}
      min={type === "number" ? 0 : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  </label>
);

export function AdminSetup({
  section,
  preview,
}: {
  section: "Team" | "Menu" | "Settings";
  preview: boolean;
}) {
  const [team, setTeam] = useState<Member[]>([]),
    [menu, setMenu] = useState<Item[]>([]),
    [categories,setCategories]=useState<Category[]>([]),
    [settings, setSettings] = useState<Settings>(defaults);
  const [name, setName] = useState(""),
    [username, setUsername] = useState(""),
    [phone, setPhone] = useState(""),
    [pin, setPin] = useState(""),
    [role, setRole] = useState("rider");
  const [itemTitle, setItemTitle] = useState(""),
    [itemPrice, setItemPrice] = useState(""),
    [itemCategory, setItemCategory] = useState("Mains"),
    [editingItem,setEditingItem]=useState<string|null>(null),
    [categoryTitle,setCategoryTitle]=useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    if (preview) return;
    try {
      const data = await Parse.Cloud.run("adminListSetup");
      setTeam(data.team);
      setMenu(data.menu);
      setCategories(data.categories||[]);
      if (data.settings) setSettings({ ...defaults, ...data.settings });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load setup");
    }
  }, [preview]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (
    fn: string,
    payload: Record<string, unknown>,
    after: () => void,
  ) => {
    if (preview) {
      setError("Sign in as an owner to change operational data.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await Parse.Cloud.run(fn, payload);
      after();
      await load();
      setNotice("Saved to the restaurant database.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setup-page">
      {error && <p className="ops-error">{error}</p>}
      {notice && <p className="setup-notice">{notice}</p>}
      {preview && (
        <p className="setup-notice">
          Live setup is available to signed-in owners. Preview is read-only.
        </p>
      )}
      {section === "Team" && (
        <>
          <div className="admin-panel">
            <div className="panel-title">
              <div>
                <p className="eyebrow">Access control</p>
                <h2>Create rider or cashier</h2>
              </div>
            </div>
            <form
              className="setup-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save(
                  "adminCreateTeamMember",
                  { name, username, phone, pin, role },
                  () => {
                    setName("");
                    setUsername("");
                    setPhone("");
                    setPin("");
                  },
                );
              }}
            >
              {input("Full name", name, setName)}
              {input("Username", username, setUsername)}
              {input("Phone", phone, setPhone)}
              {input("PIN (4+ digits)", pin, setPin, "password")}
              <label className="setup-field">
                Role
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="rider">Rider</option>
                  <option value="cashier">Cashier</option>
                </select>
              </label>
              <button disabled={busy || preview} className="setup-submit">
                Create team member
              </button>
            </form>
          </div>
          <div className="admin-panel">
            <h2>Team members</h2>
            {team.map((u) => (
              <div key={u.id}>
                <div className="setup-row">
                  <div>
                    <b>{u.name}</b>
                    <small>
                      @{u.username} · {u.role}
                    </small>
                  </div>
                  <span>{u.active ? "Active" : "Inactive"}</span>
                  {['rider','cashier'].includes(u.role)&&<select aria-label={`Role for ${u.name}`} value={u.role} disabled={busy||preview} onChange={e=>void save('adminChangeRole',{userId:u.id,role:e.target.value},()=>{})}><option value="rider">Rider</option><option value="cashier">Cashier</option></select>}
                  <button
                    disabled={busy || preview || u.role === "admin"}
                    onClick={() =>
                      void save(
                        "adminUpdateMember",
                        { id: u.id, active: !u.active },
                        () => {},
                      )
                    }
                  >
                    {u.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
                {u.role === "rider" && (
                  <CommissionEditor
                    key={`${u.id}-${u.commissionType}-${u.commissionPerOrder}-${u.commissionPercent}`}
                    member={u}
                    disabled={busy || preview}
                    save={(payload) =>
                      save(
                        "adminUpdateMember",
                        { id: u.id, ...payload },
                        () => {},
                      )
                    }
                  />
                )}
              </div>
            ))}
            {!team.length && (
              <p className="empty-orders">No team members loaded yet.</p>
            )}
          </div>
        </>
      )}
      {section === "Menu" && (
        <>
          <div className="admin-panel"><p className="eyebrow">Organize the catalog</p><h2>Categories</h2><form className="category-create" onSubmit={e=>{e.preventDefault();void save('adminSaveCategory',{title:categoryTitle},()=>setCategoryTitle(''))}}><input required placeholder="New category name" value={categoryTitle} onChange={e=>setCategoryTitle(e.target.value)}/><button disabled={busy||preview}>Add category</button></form>{categories.map(category=><CategoryEditor key={`${category.id}-${category.title}-${category.active}`} category={category} disabled={busy||preview} save={payload=>save('adminSaveCategory',{id:category.id,...payload},()=>{})}/>)}</div>
          <div className="admin-panel">
            <p className="eyebrow">Restaurant catalog</p>
            <h2>{editingItem?'Edit menu item':'Add menu item'}</h2>
            <form
              className="setup-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save(
                  "adminSaveMenuItem",
                  {
                    id:editingItem||undefined,
                    title: itemTitle,
                    price: Number(itemPrice),
                    category: itemCategory,
                  },
                  () => {
                    setItemTitle("");
                    setItemPrice("");
                    setEditingItem(null);
                  },
                );
              }}
            >
              {input("Item name", itemTitle, setItemTitle)}
              {input("Price", itemPrice, setItemPrice, "number")}
              <label className="setup-field">
                Category
                <select
                  value={itemCategory}
                  onChange={(e) => setItemCategory(e.target.value)}
                >
                  {(categories.length?categories.filter(c=>c.active).map(c=>c.title):["Breakfast", "Mains", "Drinks", "Sides", "Desserts"]).map(
                    (c) => (
                      <option key={c}>{c}</option>
                    ),
                  )}
                </select>
              </label>
              <button className="setup-submit" disabled={busy || preview}>
                {editingItem?'Save item changes':'Add menu item'}
              </button>
              {editingItem&&<button type="button" className="setup-secondary" onClick={()=>{setEditingItem(null);setItemTitle('');setItemPrice('')}}>Cancel editing</button>}
            </form>
          </div>
          <div className="admin-panel">
            <h2>Menu items</h2>
            {menu.map((item) => (
              <div className="setup-row" key={item.id}>
                <div>
                  <b>{item.title}</b>
                  <small>
                    {item.category} · UGX {item.price.toLocaleString()}
                  </small>
                </div>
                <span>{item.availableToday ? "Available" : "Unavailable"}</span>
                <button disabled={busy||preview} onClick={()=>{setEditingItem(item.id);setItemTitle(item.title);setItemPrice(String(item.price));setItemCategory(item.category);window.scrollTo({top:0,behavior:'smooth'})}}>Edit</button>
                <button
                  disabled={busy || preview}
                  onClick={() =>
                    void save(
                      "adminSaveMenuItem",
                      { ...item, availableToday: !item.availableToday },
                      () => {},
                    )
                  }
                >
                  {item.availableToday ? "Hide today" : "Make available"}
                </button>
              </div>
            ))}
            {!menu.length && (
              <p className="empty-orders">No menu items saved yet.</p>
            )}
          </div>
        </>
      )}
      {section === "Settings" && (
        <div className="admin-panel">
          <p className="eyebrow">Restaurant configuration</p>
          <h2>Operating settings</h2>
          <form
            className="setup-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save("adminSaveSettings", settings, () => {});
            }}
          >
            {input("Restaurant name", settings.restaurantName, (v) =>
              setSettings((p) => ({ ...p, restaurantName: v })),
            )}
            {input("Currency symbol", settings.currencySymbol, (v) =>
              setSettings((p) => ({ ...p, currencySymbol: v })),
            )}
            {input(
              "Default delivery fee",
              settings.defaultDeliveryFee,
              (v) =>
                setSettings((p) => ({ ...p, defaultDeliveryFee: Number(v) })),
              "number",
            )}
            {input(
              "Maximum rider float",
              settings.maxRiderFloat,
              (v) => setSettings((p) => ({ ...p, maxRiderFloat: Number(v) })),
              "number",
            )}
            <label className="setup-checkbox">
              <input
                type="checkbox"
                checked={settings.allowBatching}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    allowBatching: e.target.checked,
                  }))
                }
              />{" "}
              Allow riders to batch orders
            </label>
            <button className="setup-submit" disabled={busy || preview}>
              Save settings
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function CommissionEditor({
  member,
  disabled,
  save,
}: {
  member: Member;
  disabled: boolean;
  save: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [type, setType] = useState(member.commissionType),
    [flat, setFlat] = useState(member.commissionPerOrder),
    [percent, setPercent] = useState(member.commissionPercent);
  return (
    <div className="commission-editor">
      <label>
        Commission rule
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="per_order">Fixed per order</option>
          <option value="percent">Percent of subtotal</option>
          <option value="hybrid">Fixed + percent</option>
        </select>
      </label>
      {type !== "percent" && (
        <label>
          Fixed amount
          <input
            type="number"
            min="0"
            value={flat}
            onChange={(e) => setFlat(Number(e.target.value))}
          />
        </label>
      )}
      {type !== "per_order" && (
        <label>
          Percent
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={percent}
            onChange={(e) => setPercent(Number(e.target.value))}
          />
        </label>
      )}
      <button
        disabled={disabled}
        onClick={() =>
          void save({
            commissionType: type,
            commissionPerOrder: flat,
            commissionPercent: percent,
          })
        }
      >
        Save rule
      </button>
    </div>
  );
}

function CategoryEditor({category,disabled,save}:{category:Category;disabled:boolean;save:(payload:Record<string,unknown>)=>Promise<void>}){
 const [title,setTitle]=useState(category.title)
 return <div className="setup-row"><input aria-label="Category name" value={title} onChange={e=>setTitle(e.target.value)} /><span>{category.active?'Active':'Hidden'}</span><button disabled={disabled||!title.trim()} onClick={()=>void save({title,active:category.active})}>Save name</button><button disabled={disabled} onClick={()=>void save({title,active:!category.active})}>{category.active?'Hide':'Show'}</button></div>
}
