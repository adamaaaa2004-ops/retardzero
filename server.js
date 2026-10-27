import http from "node:http";
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

const text = (t) => t?.translation?.[0]?.text ?? "";
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
    .filter((e) => e.tripUpdate && String(e.tripUpdate.trip?.tripId ?? "").includes(num))
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

  const messages = alerts.entity
    .filter(
      (e) =>
        e.alert &&
        isActiveNow(e.alert) &&
        e.alert.informedEntity?.some((i) => String(i.trip?.tripId ?? "").includes(num))
    )
    .map((e) => ({ title: text(e.alert.headerText), detail: clean(text(e.alert.descriptionText)) }));

  return {
    train: num,
    found: trips.length > 0,
    trips,
    messages,
    stationNamesLoaded: stationNames.size,
    updatedAt: new Date().toISOString(),
  };
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (url.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200).end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:18px system-ui;padding:20px;max-width:500px;margin:auto"><h2>RetardZéro : test</h2><form action="/api/train"><input name="num" placeholder="N° de train (ex : 6601)" inputmode="numeric" style="font:inherit;padding:12px;width:100%;box-sizing:border-box"><button style="font:inherit;padding:12px;margin-top:10px;width:100%">Chercher</button></form></body>`
      );
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