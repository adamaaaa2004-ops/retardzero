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
const ICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAB8UlEQVR42u3c0Y3CMBBF0emIQui/HqAAFAmRxPPGJ7qfK8R4z4K0sVOP50v6WlkCwSE4BIfgEByCQ3AIDsEhOCQ4BIfgEByCQ3AIDsEhOASHBIfgEByCQ3AIDsEhOASH4JDgEByCQ3AIDsEhOASH4BAcgkOCQ3AIDsEhOASH4BAcgkNwSHAIDsEhOASH4BAcgkNwCA4JDsEhOASH4BAcgkNwCA7BsbTPNf4X0HnG6rZSx9cMDSkzVsR6DVCSOGMlrlqcj9AZK3HJgohEz1jRq9bcR/qMlb5qbX0MmLEGrFpDHzNmbI3j1x+GIxvHP/On+Lj0GovjlLGb+7jh2g7HkteBIwDH2peCYz2Oc6ftdt38rnbB0flvFA444IADDjjgCMNx0ZCtcCzh6JPDJ4evFTjggAMOOODwH1I43Ftxb8VdWTjs54DDTjA7wewhbSTDHlILB4czHc6tOA1mRmdlzeiUvVP2ns/h+Rye7JNtwpN9LlzHARpyZ/Q0QcEhOASH4BAcgkNwCA7BITgkOASH4BAcgkNwCA7BITgEhwSH4BAcgkNwCA7BITgEh+CQ4BAcgkNwCA7BITgEh+AQHIJDgkNwCA7BITgEh+AQHIJDcEhwCA7BITgEh+AQHIJDcAgOCQ7BITgEh+AQHIJDcAgObdAbO2YIfnNOav8AAAAASUVORK5CYII=", "base64");
const MANIFEST = JSON.stringify({
  name: "RetardZéro",
  short_name: "RetardZéro",
  start_url: "/",
  display: "standalone",
  background_color: "#0F1624",
  theme_color: "#2F4BFF",
  icons: [{ src: "/icon.png", sizes: "180x180", type: "image/png" }],
});

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (url.pathname === "/") {
      try {
        const html = await readFile(new URL("./rz2.html", import.meta.url));
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200).end(html);
      } catch {
        res.writeHead(500).end(JSON.stringify({ error: "rz2.html manquant" }));
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
