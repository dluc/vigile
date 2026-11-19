import { begun, describeItemList, describeList, ENDS, takePage } from "/shared/paging.js";

const el = id => document.getElementById(id);
const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
const keyName = "vigile.key";
let key = "";
try { key = localStorage.getItem(keyName) ?? ""; } catch { /* Memory still works. */ }
let turn = 0, token, listing, progress;
let locked = false;
async function api(path, body) {
  const res = await fetch(`/api/${path}`, { method: body ? "POST" : "GET", redirect: "error", cache: "no-store", headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw Object.assign(new Error(res.status === 401 ? "Enter an API key to connect." : `Request failed (${res.status}).`), { status: res.status });
  return res.json();
}
function clear() {
  el("rows").replaceChildren(); el("detail").replaceChildren(); el("detail").hidden = true; el("records").hidden = true; el("more").hidden = true; el("board-link").hidden = true; el("instance").textContent = ""; token = undefined;
}
function lock(message) {
  ++turn;
  locked = true;
  clear();
  el("credential").value = "";
  el("access").hidden = false;
  el("message").textContent = message;
}
function detailFailure(error, mine) {
  if (mine !== turn) return;
  if (error.status === 401) return lock(error.message);
  else { el("detail").replaceChildren(); el("detail").hidden = true; }
  el("message").textContent = error.message;
}
function impactSection(detail, decision, type, items, mine) {
  const descriptor = describeItemList(decision, ["links",type]);
  const progress = begun();
  const more = decision.more?.links?.[type];
  let token = takePage(descriptor, progress, items, more?.continuation ?? ENDS);
  const list = text("ul", "");
  const append = entries => { for (const item of entries) list.append(text("li", `${item.id} · ${item.title}`)); };
  append(items);
  detail.append(text("h4",type),list);
  if (!token) return;
  const button = text("button", `Show more (${list.childElementCount} of ${more.total})`);
  detail.append(button);
  button.onclick = async () => {
    button.disabled = true;
    try {
      const page = await api("get", { kind:"decision", id:decision.id, continuation:token });
      if (mine !== turn) return;
      if (decision.unchanged_since !== page.unchanged_since) return void load();
      const entries = page.links?.[type], rest = page.more?.links?.[type];
      token = takePage(descriptor, progress, entries, rest?.continuation ?? ENDS);
      append(entries);
      if (!token) button.remove();
      else { button.textContent = `Show more (${list.childElementCount} of ${rest.total})`; button.disabled = false; }
    } catch (error) { detailFailure(error,mine); }
  };
}
async function load(more = false, focusDetail = false) {
  if (locked) return;
  const mine = ++turn;
  if (!more) clear();
  el("more").disabled = true;
  const filters = el("filter").value ? { status: el("filter").value } : {};
  try {
    const instance = await api("instance"); if (mine !== turn) return;
    if (!instance.features?.includes("decisions")) { clear(); location.replace("/"); return; }
    if (!more) {
      el("instance").textContent = instance.name; el("board-link").hidden = !instance.features.includes("tasks");
      listing = describeList("list_decisions", filters); progress = begun();
    }
    const result = await api("list-decisions", { ...filters, ...(more ? { continuation: token } : {}) });
    if (mine !== turn) return;
    takePage(listing, progress, result.decisions, result.continuation ?? ENDS);
    for (const decision of result.decisions) {
      const link = text("a", `${decision.id} · ${decision.title} · ${decision.status}`); link.href = `#${encodeURIComponent(decision.id)}`;
      const row = text("li", ""); row.append(link); el("rows").append(row);
    }
    token = result.continuation; el("more").hidden = !token; el("more").disabled = false; el("records").hidden = false; el("access").hidden = true;
    el("message").textContent = el("rows").childElementCount ? `${el("rows").childElementCount} decisions shown` : "No decisions in this state.";
    if (location.hash.length > 1) {
      try {
      const decision = await api("get", { kind: "decision", id: decodeURIComponent(location.hash.slice(1)), history: true }); if (mine !== turn) return;
      const stateLabel = decision.deleted_at ? `Deleted ${decision.deleted_at} (last state: ${decision.status})` : decision.status;
      const detail = el("detail"); detail.replaceChildren(text("h3", decision.title), text("small", `${decision.id} · ${stateLabel} · v${decision.version}`), text("p", decision.description));
      if (decision.why) detail.append(text("h4", "Rationale"), text("p", decision.why));
      for (const [type, items] of Object.entries(decision.links)) impactSection(detail,decision,type,items,mine);
      detail.append(text("h4","Recent changes"),text("p",(decision.history ?? []).map(h=>`${h.at} · ${h.by} · ${h.action}`).join("\n"))); detail.hidden = false;
      if (focusDetail) { const heading = detail.querySelector("h3"); heading.tabIndex = -1; heading.focus(); heading.scrollIntoView({block:"nearest"}); }
      } catch (error) { detailFailure(error,mine); }
    }
  } catch (error) {
    if (mine !== turn) return;
    if (error.status === 401) return lock(error.message);
    clear(); el("message").textContent = error.message; el("access").hidden = error.status !== 401;
  }
}
el("access").onsubmit = event => { event.preventDefault(); key = el("credential").value.trim(); el("credential").value = ""; locked = false; try { if (key) localStorage.setItem(keyName,key); else localStorage.removeItem(keyName); } catch {} void load(); };
el("refresh").onclick = el("filter").onchange = () => load(); el("more").onclick = () => load(true);
window.addEventListener("hashchange",()=>load(false,true));
window.addEventListener("storage",event=>{
  if (event.key !== keyName && event.key !== null) return;
  let stored;
  try { if (event.storageArea !== localStorage) return; stored = localStorage.getItem(keyName) ?? ""; } catch { return; }
  if (stored === key) return;
  key = stored;
  if (!key) return lock("The saved API key was removed. Connect to continue.");
  locked = false;
  void load();
});
void load();
