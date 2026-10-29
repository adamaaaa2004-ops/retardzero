import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import webpush from "web-push";
import GtfsRealtime from "gtfs-realtime-bindings";

const { transit_realtime } = GtfsRealtime;
const CANCELED = transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;

const FEEDS = {
  updates: "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates",
  alerts: "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-service-alerts",
};
const STATIONS_URL =
  "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/gares-de-voyageurs/exports/json";

const cache = {};
async function feed(name) {
  const hit = cache[name];
  if (hit && Date.now() - hit.t < 60_000) return hit.data;
  const res = await fetch(FEEDS[name]);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const data = transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  cache[name] = { t: Date.now(), data };
  return data;
}

// Noms de gares : on associe le code UIC (7 premiers chiffres) au nom.
const stationNames = new Map();
const byName = new Map();
async function loadStations() {
  try {
    const res = await fetch(STATIONS_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = await res.json();
    for (const row of rows) {
      const keys = Object.keys(row);
      const nameKey = keys.find((k) => /^nom/i.test(k));
      const uicKey = keys.find((k) => /uic/i.test(k));
      if (!nameKey || !uicKey) continue;
      for (const c of JSON.stringify(row[uicKey]).match(/\d{7,8}/g) ?? []) {
        const name = String(row[nameKey]);
        stationNames.set(c.slice(0, 7), name);
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(c.slice(0, 7));
      }
    }
    console.log(`Noms de gares chargés : ${stationNames.size}`);
  } catch (err) {
    console.log("Noms de gares indisponibles :", err.message);
  }
}
loadStations();

function stopName(stopId) {
  const m = String(stopId).match(/(\d{7,8})$/);
  return (m && stationNames.get(m[1].slice(0, 7))) || stopId;
}

const text = (t) => {
  const list = t?.translation ?? [];
  const fr = list.find((x) => /^fr/i.test(x.language ?? ""));
  return (fr ?? list[0])?.text ?? "";
};
// Le numéro doit être un "mot" entier dans l'identifiant (pas collé à d'autres chiffres).
const matches = (tripId, num) => new RegExp(`(^|\\D)${num}(\\D|$)`).test(String(tripId ?? ""));
const clean = (s) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
const sec = (v) => (v == null ? 0 : typeof v === "object" && v.toNumber ? v.toNumber() : Number(v));

// Une alerte sans période est toujours active ; sinon on vérifie qu'on est dedans.
function isActiveNow(alert) {
  const periods = alert.activePeriod ?? [];
  if (!periods.length) return true;
  const now = Date.now() / 1000;
  return periods.some((p) => now >= sec(p.start) && now <= (sec(p.end) || Infinity));
}

async function lookup(num) {
  const [updates, alerts] = await Promise.all([feed("updates"), feed("alerts")]);

  const trips = updates.entity
    .filter((e) => e.tripUpdate && matches(e.tripUpdate.trip?.tripId, num))
    .map((e) => {
      const tu = e.tripUpdate;
      const stops = (tu.stopTimeUpdate ?? []).map((s) => ({
        stopId: s.stopId,
        name: stopName(s.stopId),
        delayMin: Math.round(((s.departure?.delay ?? s.arrival?.delay ?? 0) || 0) / 60),
        time: sec(s.departure?.time ?? s.arrival?.time) || null,
      }));
      return {
        tripId: tu.trip.tripId,
        cancelled: tu.trip.scheduleRelationship === CANCELED,
        delayMin: Math.max(0, ...stops.map((s) => s.delayMin)),
        stops,
      };
    });

  const rawMessages = alerts.entity
    .filter(
      (e) =>
        e.alert &&
        isActiveNow(e.alert) &&
        e.alert.informedEntity?.some((i) => matches(i.trip?.tripId, num))
    )
    .map((e) => ({ title: text(e.alert.headerText), detail: clean(text(e.alert.descriptionText)) }));

  const seen = new Set();
  const messages = rawMessages
    .filter((m) => {
      const k = m.title + m.detail;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 5);

  return {
    train: num,
    found: trips.length > 0,
    trips,
    messages,
    stationNamesLoaded: stationNames.size,
    updatedAt: new Date().toISOString(),
  };
}

// ---------- Pages légales ----------
const escHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const EDITEUR = escHtml(process.env.EDITEUR_NOM || "[À COMPLÉTER : nom de l’éditeur]");
const EMAIL = escHtml(process.env.EDITEUR_EMAIL || "[À COMPLÉTER : e-mail de contact]");
const legalPage = (title, body) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · RetardZéro</title><style>:root{color-scheme:light dark}body{font:17px/1.6 system-ui,sans-serif;max-width:680px;margin:auto;padding:24px 18px 60px}h1{font-size:28px}h2{font-size:20px;margin-top:28px}a{color:#2F4BFF}@media (prefers-color-scheme:dark){a{color:#7C92FF}}</style></head><body><p><a href="/">‹ Retour à l’app</a></p>${body}</body></html>`;
const MENTIONS = legalPage("Mentions légales", `<h1>Mentions légales</h1>
<p>Dernière mise à jour : 29 octobre 2026.</p>
<h2>Éditeur</h2>
<p>${EDITEUR}<br>Contact : ${EMAIL}</p>
<h2>Hébergeur</h2>
<p>Render Services, Inc. (render.com). Les coordonnées complètes de l’hébergeur sont indiquées sur son site.</p>
<h2>Indépendance</h2>
<p>RetardZéro est une application indépendante. Elle n’est ni éditée, ni approuvée, ni affiliée à la SNCF ni à aucun transporteur. Les noms de marques cités appartiennent à leurs propriétaires.</p>
<h2>Source et fiabilité des données</h2>
<p>Les horaires, retards et messages proviennent des données ouvertes diffusées sur transport.data.gouv.fr. Ils sont fournis à titre indicatif, sans garantie d’exactitude, d’exhaustivité ni de disponibilité. Ils ne remplacent pas les informations officielles du transporteur. Une alerte peut arriver en retard, ou ne pas arriver.</p>
<h2>Responsabilité</h2>
<p>L’éditeur ne peut être tenu responsable d’un préjudice lié à l’utilisation de l’application, notamment un train manqué. Pour toute demande de compensation ou de remboursement, référez-vous aux conditions du transporteur.</p>`);
const CONFIDENTIALITE = legalPage("Confidentialité", `<h1>Politique de confidentialité</h1>
<p>Dernière mise à jour : 29 octobre 2026.</p>
<h2>Qui est responsable ?</h2>
<p>${EDITEUR}, joignable à ${EMAIL}.</p>
<h2>Ce que l’application ne fait pas</h2>
<p>Pas de compte, pas d’e-mail demandé, pas de publicité, pas de suivi à des fins statistiques, pas de revente de données.</p>
<h2>Les données concernées</h2>
<p><b>Sur votre appareil :</b> la liste des trains que vous suivez est enregistrée dans le stockage local de votre navigateur. Quand vous consultez un train, son numéro est envoyé à notre serveur pour récupérer son statut.</p>
<p><b>Si vous activez les alertes :</b> nous conservons sur notre serveur l’identifiant technique de notification fourni par votre appareil (adresse du service de notification d’Apple ou de Google et clés associées) et le numéro du train concerné, afin de vous envoyer les alertes.</p>
<p><b>Journaux techniques :</b> notre hébergeur peut enregistrer des informations techniques de connexion, comme l’adresse IP, pour assurer la sécurité et le fonctionnement du service.</p>
<h2>Pourquoi et sur quelle base</h2>
<p>Les alertes reposent sur votre consentement : elles ne sont activées que si vous touchez « Activer les alertes » et acceptez la demande de votre appareil. Le reste (afficher le statut d’un train, sécuriser le service) repose sur notre intérêt légitime à faire fonctionner l’application.</p>
<h2>Combien de temps</h2>
<p>Les données d’alertes sont conservées jusqu’à ce que vous désactiviez les alertes ou arrêtiez de suivre le train. Les identifiants de notification devenus invalides sont supprimés automatiquement.</p>
<h2>Qui y a accès</h2>
<p>Notre hébergeur (Render) et le service de notification de votre appareil (Apple ou Google), uniquement pour faire fonctionner l’application. Ces prestataires peuvent traiter des données hors de l’Union européenne.</p>
<h2>Vos droits</h2>
<p>Vous pouvez accéder à vos données, les corriger, les effacer ou vous opposer à leur traitement en écrivant à ${EMAIL}. Vous pouvez aussi désactiver les alertes à tout moment depuis l’application. Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la CNIL (cnil.fr).</p>`);

// ---------- Page de présentation ----------
const CONTACT = process.env.EDITEUR_EMAIL
  ? `<p class="mute">Un avis, un bug, une idée ? <a href="mailto:${escHtml(process.env.EDITEUR_EMAIL)}">Écrivez-nous</a>. En phase de test, chaque retour compte.</p>`
  : "";
const BIENVENUE = `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>RetardZéro : suivez votre train en direct</title>
<meta name="description" content="Suivez votre train en direct, voyez ses retards et ses arrêts, et recevez une alerte sur votre iPhone s’il change.">
<meta property="og:title" content="RetardZéro : suivez votre train en direct">
<meta property="og:description" content="Retards, suppressions et arrêts en direct, avec des alertes sur votre iPhone. En phase de test.">
<link rel="icon" href="/icon.png">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#EDF1F5;--card:#FFFFFF;--ink:#13203A;--mute:#5B6780;--line:#D9E0E9;--ok:#0E7C66;--late:#B45309;--acc:#2F4BFF;--accink:#FFFFFF;color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:dark){:root{--bg:#0F1624;--card:#18223A;--ink:#EAF0FB;--mute:#9AA8C4;--line:#2A3857;--ok:#3DD6B0;--late:#F5B04C;--acc:#7C92FF;--accink:#0F1624;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 "Bricolage Grotesque",system-ui,-apple-system,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:22px 20px 60px}
.brand{display:flex;align-items:center;gap:8px;font-size:22px;font-weight:800;letter-spacing:-.03em;color:var(--acc)}
.hero{display:grid;gap:36px;align-items:center;padding:42px 0 30px}
@media (min-width:820px){.hero{grid-template-columns:1.1fr .9fr}}
h1{font-size:clamp(34px,6vw,54px);line-height:1.05;letter-spacing:-.035em;margin:0 0 16px;font-weight:800}
h2{font-size:26px;letter-spacing:-.02em;margin:48px 0 14px}
.lead{font-size:19px;color:var(--mute);margin:0 0 24px;max-width:34em}
.btn{display:inline-block;background:var(--acc);color:var(--accink);text-decoration:none;font-weight:700;border-radius:16px;padding:15px 24px}
.btn:focus-visible,a:focus-visible{outline:3px solid var(--acc);outline-offset:3px}
.mute{color:var(--mute);font-size:15px}
.mock{position:relative}
.note{background:var(--ink);color:var(--bg);border-radius:16px;padding:12px 16px;font-size:15px;margin-bottom:14px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:16px 18px}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.big{font-size:30px;font-weight:800;letter-spacing:-.03em}
.pill{font-weight:700;font-size:13px;padding:4px 11px;border-radius:99px;white-space:nowrap;color:var(--late);background:color-mix(in srgb,var(--late) 17%,transparent)}
.pill.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}
.rt{position:relative;padding-left:24px;margin:12px 0 4px;font-weight:600}
.rt:before{content:"";position:absolute;left:5px;top:12px;bottom:12px;width:2px;background:var(--line)}
.rt div{position:relative;padding:4px 0}
.rt div:before{content:"";position:absolute;left:-24px;top:9px;width:12px;height:12px;border-radius:50%;border:2px solid var(--ink);background:var(--card)}
.rt div.e:before{background:var(--ink)}
.grid{display:grid;gap:14px}
@media (min-width:700px){.grid.three{grid-template-columns:repeat(3,1fr)}}
.grid h3{margin:0 0 6px;font-size:19px}
.grid p{margin:0;color:var(--mute);font-size:16px}
ol{padding-left:22px;margin:0}
ol li{margin:10px 0}
.warn{border-left:6px solid var(--late)}
footer{margin-top:50px;padding-top:20px;border-top:1px solid var(--line)}
a{color:var(--acc)}
</style></head>
<body><div class="wrap">
<div class="brand"><svg width="28" height="28" viewBox="0 0 26 26" aria-hidden="true"><circle cx="5" cy="13" r="4" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M9 13h8" stroke="currentColor" stroke-width="2.5"/><circle cx="21" cy="13" r="4" fill="currentColor"/></svg>RetardZéro</div>

<section class="hero">
<div>
<h1>Votre train change ? Vous le savez.</h1>
<p class="lead">Suivez votre train en direct : retards, suppressions, arrêts avec leurs horaires. Activez les alertes et votre iPhone vous prévient.</p>
<a class="btn" href="/">Ouvrir l’app</a>
<p class="mute" style="margin-top:14px">Gratuit pendant la phase de test. Pas de compte à créer.</p>
</div>
<div class="mock" aria-label="Exemple d’affichage">
<div class="note"><b>Train 6177 : retard de 12 min</b><br>Ouvrez RetardZéro pour voir les détails.</div>
<div class="card">
<div class="row"><span class="big">14:22</span><span class="pill">Retard de 12 min</span></div>
<div class="rt"><div>Paris Gare de Lyon</div><div class="e">Nice</div></div>
<div class="mute">Train 6177 · exemple illustratif</div>
</div>
</div>
</section>

<h2>Ce que fait l’app</h2>
<div class="grid three">
<div class="card"><h3>Suivi en direct</h3><p>Le statut de votre train, ses prochains arrêts et leurs horaires, à jour toutes les minutes.</p></div>
<div class="card"><h3>Recherche simple</h3><p>Tapez vos deux gares, ou le numéro de votre train, et choisissez celui que vous prenez.</p></div>
<div class="card"><h3>Alertes sur iPhone</h3><p>Une notification en cas de retard, de suppression ou de retour à l’heure.</p></div>
</div>

<h2>L’installer sur iPhone</h2>
<div class="card"><ol>
<li>Ouvrez cette page dans <b>Safari</b>.</li>
<li>Touchez le bouton <b>Partager</b>, puis <b>Sur l’écran d’accueil</b>.</li>
<li>Ouvrez RetardZéro depuis sa nouvelle icône, ajoutez un train, puis touchez <b>Activer les alertes</b>.</li>
</ol></div>
<p class="mute">Les alertes ne fonctionnent que si l’app est ouverte depuis l’icône de l’écran d’accueil. La version Android n’a pas encore été testée.</p>

<h2>Une version de test</h2>
<div class="card warn"><p style="margin:0">RetardZéro est un projet indépendant en cours de test. Les données viennent des données ouvertes de la SNCF et sont fournies à titre indicatif. Une alerte peut arriver en retard, ou ne pas arriver : ne vous y fiez pas pour un trajet critique.</p></div>
${CONTACT}

<footer class="mute">
Application indépendante, non affiliée à la SNCF.<br>
<a href="/mentions-legales">Mentions légales</a> · <a href="/confidentialite">Confidentialité</a>
</footer>
</div></body></html>`;

// ---------- Recherche par gares ----------
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function findStations(q) {
  const terms = norm(q).split(" ").filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const [name, codes] of byName) {
    const k = norm(name);
    if (terms.every((t) => k.includes(t))) out.push({ name, codes: [...codes], rank: k.startsWith(terms[0]) ? 0 : 1 });
  }
  out.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
  return out.slice(0, 6).map(({ name, codes }) => ({ name, codes }));
}
const codeOf = (stopId) => {
  const m = String(stopId).match(/(\d{7,8})$/);
  return m ? m[1].slice(0, 7) : null;
};
async function searchTrains(fromCodes, toCodes) {
  const updates = await feed("updates");
  const from = new Set(fromCodes);
  const to = new Set(toCodes);
  const now = Date.now() / 1000;
  const seen = new Set();
  const out = [];
  for (const e of updates.entity) {
    const tu = e.tripUpdate;
    if (!tu) continue;
    const st = tu.stopTimeUpdate ?? [];
    const i = st.findIndex((s) => from.has(codeOf(s.stopId)));
    if (i < 0) continue;
    const j = st.findIndex((s, k) => k > i && to.has(codeOf(s.stopId)));
    if (j < 0) continue;
    const num = String(tu.trip?.tripId ?? "").match(/\d{3,6}/)?.[0];
    if (!num || seen.has(num)) continue;
    const departAt = sec(st[i].departure?.time ?? st[i].arrival?.time) || null;
    if (departAt && departAt < now - 600) continue;
    seen.add(num);
    out.push({
      num,
      departAt,
      arriveAt: sec(st[j].arrival?.time ?? st[j].departure?.time) || null,
      delayMin: Math.round(((st[i].departure?.delay ?? st[i].arrival?.delay ?? 0) || 0) / 60),
      cancelled: tu.trip.scheduleRelationship === CANCELED,
    });
  }
  out.sort((a, b) => (a.departAt ?? Infinity) - (b.departAt ?? Infinity));
  return out.slice(0, 20);
}

// ---------- Alertes (notifications push) ----------
const SUBS_FILE = process.env.SUBS_PATH || new URL("./subs.json", import.meta.url);
const pushOn = !!(process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE);
if (pushOn) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "https://retardzero.onrender.com",
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
  );
}
let subs = [];
try {
  subs = JSON.parse(await readFile(SUBS_FILE, "utf8"));
} catch {}
async function saveSubs() {
  try {
    await writeFile(SUBS_FILE, JSON.stringify(subs));
  } catch {}
}

function stateOf(r) {
  const t = r.trips[0];
  if (!t) return "none";
  if (t.cancelled) return "cancelled";
  if (t.delayMin >= 5) return "late" + Math.floor(t.delayMin / 10) * 10;
  return "ok";
}
function noteFor(num, r, prev) {
  const t = r.trips[0];
  const s = stateOf(r);
  if (s === "cancelled") return { title: "Train " + num + " supprimé", body: "Ouvrez RetardZéro pour voir les détails." };
  if (s.startsWith("late")) return { title: "Train " + num + " : retard de " + t.delayMin + " min", body: "Ouvrez RetardZéro pour voir les détails." };
  if (s === "ok" && prev && prev !== "ok") return { title: "Train " + num + " : à l’heure", body: "Le retard est résorbé." };
  return null;
}
async function send(x, n) {
  console.log("Notification :", n.title);
  try {
    await webpush.sendNotification(x.sub, JSON.stringify(n));
  } catch (err) {
    console.log("Push échec :", err.statusCode || err.message);
    if (err.statusCode === 404 || err.statusCode === 410) subs = subs.filter((z) => z !== x);
  }
}
async function checkAll() {
  const nums = [...new Set(subs.map((s) => s.num))];
  for (const num of nums) {
    let r;
    try {
      r = await lookup(num);
    } catch (e) {
      console.log("Vérification impossible :", e.message);
      continue;
    }
    const s = stateOf(r);
    if (s === "none") continue;
    for (const x of subs.filter((z) => z.num === num)) {
      if (x.last === s) continue;
      const n = noteFor(num, r, x.last);
      x.last = s;
      if (n) await send(x, n);
    }
  }
  await saveSubs();
}
if (pushOn) setInterval(() => checkAll().catch((e) => console.log(e.message)), Number(process.env.CHECK_MS) || 120000);

function readBody(req) {
  return new Promise((ok, ko) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 20000) {
        ko(new Error("Requête trop grosse"));
        req.destroy();
      }
    });
    req.on("end", () => ok(b));
    req.on("error", ko);
  });
}

const SW = `self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data.json(); } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || "RetardZéro", { body: d.body || "", icon: "/icon.png" }));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then(function (l) { return l.length ? l[0].focus() : clients.openWindow("/"); }));
});`;
const ICON = Buffer.from("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", "base64");
const MANIFEST = JSON.stringify({
  name: "RetardZéro",
  short_name: "RetardZéro",
  start_url: "/",
  display: "standalone",
  background_color: "#0F1624",
  theme_color: "#2F4BFF",
  icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png" }],
});

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (url.pathname === "/") {
      try {
        const html = await readFile(new URL("./rz4.html", import.meta.url));
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200).end(html);
      } catch {
        res.writeHead(500).end(JSON.stringify({ error: "rz4.html manquant" }));
      }
      return;
    }
    if (url.pathname === "/api/stations") {
      res.writeHead(200).end(JSON.stringify({ stations: findStations(url.searchParams.get("q") ?? "") }));
      return;
    }
    if (url.pathname === "/api/search") {
      const parse = (v) => (v ?? "").split(",").map((c) => c.replace(/\D/g, "").slice(0, 7)).filter(Boolean).slice(0, 10);
      const f = parse(url.searchParams.get("from"));
      const t = parse(url.searchParams.get("to"));
      if (!f.length || !t.length) {
        res.writeHead(400).end(JSON.stringify({ error: "Gares manquantes" }));
        return;
      }
      try {
        const trains = await searchTrains(f, t);
        res.writeHead(200).end(JSON.stringify({ trains }));
      } catch (err) {
        res.writeHead(502).end(JSON.stringify({ error: String(err.message) }));
      }
      return;
    }
    if (url.pathname === "/mentions-legales" || url.pathname === "/confidentialite") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200).end(url.pathname === "/confidentialite" ? CONFIDENTIALITE : MENTIONS);
      return;
    }
    if (url.pathname === "/api/unsubscribe" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const num = String(body.num ?? "").replace(/\D/g, "");
        subs = subs.filter((z) => !(z.sub.endpoint === body.endpoint && z.num === num));
        await saveSubs();
        res.writeHead(200).end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400).end(JSON.stringify({ error: String(err.message) }));
      }
      return;
    }
    if (url.pathname === "/bienvenue") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200).end(BIENVENUE);
      return;
    }
    if (url.pathname === "/manifest.json") {
      res.setHeader("Content-Type", "application/manifest+json");
      res.writeHead(200).end(MANIFEST);
      return;
    }
    if (url.pathname === "/sw.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.writeHead(200).end(SW);
      return;
    }
    if (url.pathname === "/icon.png") {
      res.setHeader("Content-Type", "image/png");
      res.writeHead(200).end(ICON);
      return;
    }
    if (url.pathname === "/api/vapid") {
      res.writeHead(200).end(JSON.stringify({ key: pushOn ? process.env.VAPID_PUBLIC : null }));
      return;
    }
    if (url.pathname === "/api/subscribe" && req.method === "POST") {
      if (!pushOn) {
        res.writeHead(503).end(JSON.stringify({ error: "Alertes non configurées" }));
        return;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const num = String(body.num ?? "").replace(/\D/g, "");
        if (!body.subscription?.endpoint || !num) throw new Error("Données invalides");
        if (subs.length >= 500) throw new Error("Trop d’abonnés pour cette démo");
        let last = "ok";
        try {
          const s = stateOf(await lookup(num));
          if (s !== "none") last = s;
        } catch {}
        subs = subs.filter((z) => !(z.sub.endpoint === body.subscription.endpoint && z.num === num));
        subs.push({ sub: body.subscription, num, last });
        await saveSubs();
        res.writeHead(200).end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400).end(JSON.stringify({ error: String(err.message) }));
      }
      return;
    }
    if (url.pathname === "/api/test" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const x = subs.find((z) => z.sub.endpoint === body.endpoint);
        if (x) await send(x, { title: "RetardZéro", body: "Les alertes fonctionnent ✅" });
        res.writeHead(200).end(JSON.stringify({ ok: !!x }));
      } catch (err) {
        res.writeHead(400).end(JSON.stringify({ error: String(err.message) }));
      }
      return;
    }
    if (url.pathname !== "/api/train") {
      res.writeHead(404).end(JSON.stringify({ error: "Utilisez /api/train?num=6601" }));
      return;
    }
    const num = (url.searchParams.get("num") ?? "").replace(/\D/g, "");
    if (!num) {
      res.writeHead(400).end(JSON.stringify({ error: "Numéro de train manquant" }));
      return;
    }
    try {
      const result = await lookup(num);
      res.writeHead(200).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(502).end(JSON.stringify({ error: String(err.message) }));
    }
  })
  .listen(process.env.PORT || 3000, () => console.log("RetardZéro API prête"));
