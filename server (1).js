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
        stationNames.set(c.slice(0, 7), String(row[nameKey]));
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

// ---------- Alertes (notifications push) ----------
const SUBS_FILE = new URL("./subs.json", import.meta.url);
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
        const html = await readFile(new URL("./index.html", import.meta.url));
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200).end(html);
      } catch {
        res.writeHead(500).end(JSON.stringify({ error: "index.html manquant" }));
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
