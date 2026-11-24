// Job collector – runs on a schedule (GitHub Actions). Node 20+, no dependencies.
import fs from "fs";
import crypto from "crypto";
const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
const rd = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const old = rd("data/jobs.json", []);
const oldStat = rd("data/status.json", {});
const now = new Date().toISOString();
const strip = h => (h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;|&#39;/g, " ").replace(/\s+/g, " ").trim();
const num = s => Number(String(s).replace(/[.,](?=\d{3}\b)/g, ""));
function parseSal(s) {
  const n = (String(s || "").match(/\d[\d.,]*/g) || []).map(num).filter(x => x >= 1e6);
  return n.length ? { salMin: Math.min(...n), salMax: Math.max(...n) } : {};
}
const get = async (u, o) => { const r = await fetch(u, o); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

/* ---------- sources: each returns normalized jobs ---------- */
const S = {
  jooble: { name: "Jooble (aggregator)", needs: "JOOBLE_KEY", async run() {
    const out = [];
    for (const k of cfg.keywords) for (const l of cfg.locations) {
      const d = await get(`https://jooble.org/api/${process.env.JOOBLE_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keywords: k, location: l }) });
      for (const j of d.jobs || []) out.push({ title: j.title, company: j.company, location: j.location, desc: strip(j.snippet), ...parseSal(j.salary), url: j.link, via: j.source || "Jooble", posted: j.updated });
    } return out; } },
  google_jobs: { name: "Google Jobs (via SerpApi)", needs: "SERPAPI_KEY", async run() {
    const out = [];
    for (const k of cfg.keywords.slice(0, 4)) for (const l of cfg.locations.slice(0, 3)) {
      const d = await get(`https://serpapi.com/search.json?engine=google_jobs&q=${encodeURIComponent(k)}&location=${encodeURIComponent(l + ", Indonesia")}&api_key=${process.env.SERPAPI_KEY}`);
      for (const j of d.jobs_results || []) out.push({ title: j.title, company: j.company_name, location: j.location, desc: strip(j.description), ...parseSal(j.detected_extensions?.salary), url: j.apply_options?.[0]?.link || j.share_link, via: j.via?.replace(/^via /, "") || "Google Jobs", posted: j.detected_extensions?.posted_at });
    } return out; } },
  greenhouse: { name: "Company career pages – Greenhouse", needs: null, async run() {
    const out = [];
    for (const b of cfg.greenhouseBoards) { const d = await get(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`);
      for (const j of d.jobs || []) out.push({ title: j.title, company: b, location: j.location?.name, desc: strip(j.content), url: j.absolute_url, via: "Career page: " + b, posted: j.updated_at }); }
    return out; } },
  lever: { name: "Company career pages – Lever", needs: null, async run() {
    const out = [];
    for (const c of cfg.leverCompanies) { const d = await get(`https://api.lever.co/v0/postings/${c}?mode=json`);
      for (const j of d) out.push({ title: j.text, company: c, location: j.categories?.location, desc: j.descriptionPlain, url: j.hostedUrl, via: "Career page: " + c, posted: new Date(j.createdAt).toISOString() }); }
    return out; } },
};

/* ---------- matching (transparent rule-based score) ---------- */
function score(j) {
  const p = cfg.profile, pos = j.title.toLowerCase(), tx = (pos + " " + (j.desc || "")).toLowerCase(), P = {};
  P.role = Math.max(0, ...p.targetTitles.map(t => pos.includes(t) ? 100 : Math.round(100 * t.split(/\W+/).filter(w => w.length > 2 && pos.includes(w)).length / Math.max(1, t.split(/\W+/).filter(w => w.length > 2).length))));
  const hit = p.skills.filter(k => tx.includes(k)); P.skills = j.desc ? Math.min(100, Math.round(100 * hit.length / 8)) : 50;
  const m = tx.match(/(\d+)\s*\+?\s*(?:tahun|years?|yrs)/); let ex = !m ? 80 : +m[1] <= p.years ? 100 : Math.max(20, 100 - (+m[1] - p.years) * 25);
  if (/\b(head|director|vp|general manager)\b/.test(pos)) ex -= 35; P.exp = Math.max(10, ex);
  const L = (j.location || "").toLowerCase(); P.loc = /remote/.test(tx) ? 90 : p.priorityCities.some(c => L.includes(c)) ? 100 : /hybrid/.test(tx) ? 80 : p.otherCities.some(c => L.includes(c)) ? 80 : L ? 30 : 60;
  const mx = j.salMax; P.sal = !mx ? null : mx >= p.salMin ? 100 : 35;
  const gw = ["manager", "director", "ceo", "owner", "strategic", "leadership", "management", "executive"].filter(w => tx.includes(w)).length; P.grow = Math.min(100, 35 + gw * 20);
  const W = { role: 30, skills: 25, exp: 15, loc: 15, sal: 10, grow: 5 }; let a = 0, b = 0;
  for (const k in W) if (P[k] != null) { a += P[k] * W[k]; b += W[k]; }
  return { score: Math.round(a / b), parts: P, matchedSkills: hit.slice(0, 6) };
}

/* ---------- run ---------- */
const stat = {}, seen = new Map(), okSources = new Set();
const keyOf = j => crypto.createHash("sha1").update((j.company + "|" + j.title).toLowerCase().replace(/[^a-z0-9|]/g, "")).digest("hex").slice(0, 12);
for (const [id, s] of Object.entries(S)) {
  const prev = oldStat[id] || {};
  if (s.needs && !process.env[s.needs]) { stat[id] = { name: s.name, state: "needs_key", message: `Set secret ${s.needs}`, lastSync: prev.lastSync, count: prev.count || 0 }; continue; }
  if (id === "greenhouse" && !cfg.greenhouseBoards.length || id === "lever" && !cfg.leverCompanies.length) { stat[id] = { name: s.name, state: "not_configured", message: "Isi daftar perusahaan di config.json", count: 0 }; continue; }
  try {
    const jobs = (await s.run()).filter(j => j.title && j.company && j.url);
    for (const j of jobs) { const id2 = keyOf(j); const e = seen.get(id2); const link = { platform: j.via, url: j.url };
      if (e) { if (!e.links.some(l => l.url === j.url)) e.links.push(link); Object.assign(e, { salMin: e.salMin || j.salMin, salMax: e.salMax || j.salMax }); if ((j.desc || "").length > (e.desc || "").length) e.desc = j.desc; }
      else seen.set(id2, { id: id2, ...j, links: [link] }); }
    okSources.add(id); stat[id] = { name: s.name, state: "connected", lastSync: now, count: jobs.length };
  } catch (e) { stat[id] = { name: s.name, state: "error", message: String(e.message), lastSync: prev.lastSync, count: prev.count || 0 }; }
}
// merge with previous records
const prev = new Map(old.map(j => [j.id, j])), out = [];
for (const [id, j] of seen) {
  const sc = score(j); if (sc.score < cfg.minScore && !prev.has(id)) continue;
  const o = prev.get(id), changed = o && (o.desc !== j.desc || o.salMax !== j.salMax);
  out.push({ ...j, ...sc, firstSeen: o?.firstSeen || now, lastSeen: now, updatedAt: changed ? now : o?.updatedAt, missed: 0, expired: false });
}
for (const o of old) if (!seen.has(o.id)) { // not found this run → maybe expired (only if sources succeeded)
  if (okSources.size) o.missed = (o.missed || 0) + 1; o.expired = o.missed >= cfg.expireAfterMissedRuns; out.push(o); }
const live = out.filter(j => !j.expired), d = Date.now() - 864e5;
const digest = { generatedAt: now,
  newJobs: live.filter(j => new Date(j.firstSeen) > d).sort((a, b) => b.score - a.score).slice(0, 20).map(j => j.id),
  best: [...live].sort((a, b) => b.score - a.score).slice(0, 10).map(j => j.id),
  highSalary: live.filter(j => j.salMax >= cfg.profile.salMin).sort((a, b) => b.salMax - a.salMax).slice(0, 10).map(j => j.id),
  updated: live.filter(j => j.updatedAt && new Date(j.updatedAt) > d).map(j => j.id) };
fs.writeFileSync("data/jobs.json", JSON.stringify(out, null, 1));
fs.writeFileSync("data/status.json", JSON.stringify({ updatedAt: now, sources: stat }, null, 1));
fs.writeFileSync("data/digest.json", JSON.stringify(digest, null, 1));
console.log(`Done: ${live.length} live jobs, ${out.length - live.length} expired`, Object.fromEntries(Object.entries(stat).map(([k, v]) => [k, v.state])));
