const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const API_KEY = "3e9c100a314a16a7df2a9364b1a7f8cfa775e478";
const BBOX = [[47.0, -126.5], [51.0, -121.5]];

// ── Vessel position cache ──
// Key = MMSI string, Value = { mmsi, lat, lng, name, speed, heading, timestamp }
const vesselCache = {};
const CACHE_TTL_MS = 30 * 60 * 1000; // Drop vessels not seen in 30 minutes

// Clean stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - CACHE_TTL_MS;
  let removed = 0;
  for (const mmsi in vesselCache) {
    if (vesselCache[mmsi].timestamp < cutoff) {
      delete vesselCache[mmsi];
      removed++;
    }
  }
  if (removed > 0) console.log(`Cache cleanup: removed ${removed} stale vessels, ${Object.keys(vesselCache).length} remaining`);
}, 5 * 60 * 1000);

// ── Parse an AIS message and update the cache ──
function updateCache(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg) return;

    const meta = msg.MetaData || {};
    const mmsi = meta.MMSI || meta.mmsi;
    if (!mmsi) return;

    let lat = meta.latitude || meta.Latitude;
    let lng = meta.longitude || meta.Longitude;
    let name = (meta.ShipName || meta.ship_name || "").trim();
    let speed = null, heading = null;

    if (msg.Message) {
      const p = msg.Message.PositionReport
             || msg.Message.StandardClassBCSPositionReport
             || {};
      if (p.Latitude  != null) lat = p.Latitude;
      if (p.Longitude != null) lng = p.Longitude;
      if (p.Sog != null) speed = p.Sog;
      if (p.TrueHeading != null && p.TrueHeading < 360) heading = p.TrueHeading;

      const s = msg.Message.ShipStaticData || {};
      if (s.Name) name = s.Name.trim();
    }

    if (lat && lng) {
      vesselCache[String(mmsi)] = {
        mmsi: String(mmsi),
        lat, lng, name,
        speed:   speed   != null ? speed   : null,
        heading: heading != null ? heading : null,
        timestamp: Date.now()
      };
    }
  } catch (e) {
    // Ignore malformed messages
  }
}

// ── HTTP server with /api/vessels endpoint ──
const server = http.createServer((req, res) => {
  // CORS headers so the browser allows the request
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Vessel snapshot endpoint
  if (req.method === "GET" && req.url === "/api/vessels") {
    const vessels = Object.values(vesselCache);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(vessels));
    return;
  }

  // Health check (also useful for UptimeRobot pings to prevent cold starts)
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      vessels: Object.keys(vesselCache).length,
      upstreamConnected: upstream && upstream.readyState === WebSocket.OPEN
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found\n");
});

// ── WebSocket server for browser clients ──
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`AIS Proxy listening on port ${PORT}`);
  connectUpstream(); // Start the shared upstream connection on boot
});

// ── Shared upstream AIS connection ──
let upstream = null;
let upstreamRetries = 0;
let msgCount = 0;

function connectUpstream() {
  console.log("Connecting to upstream AIS...");
  upstream = new WebSocket(AIS_URL);

  upstream.on("open", () => {
    upstreamRetries = 0;
    msgCount = 0;
    console.log("Upstream open — sending subscription");
    const sub = {
      Apikey: API_KEY,
      BoundingBoxes: [BBOX],
      FilterMessageTypes: ["PositionReport", "StandardClassBCSPositionReport", "ShipStaticData"]
    };
    console.log("Subscription:", JSON.stringify(sub));
    upstream.send(JSON.stringify(sub));
  });

  upstream.on("message", (data) => {
    const raw = data.toString();
    msgCount++;

    // Log first 3 messages for debugging
    if (msgCount <= 3) {
      console.log(`Upstream msg #${msgCount}:`, raw.slice(0, 300));
    } else if (msgCount === 4) {
      console.log("Data flowing normally — suppressing further logs");
    }

    // Update the vessel cache
    updateCache(raw);

    // Broadcast to all connected browser clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    });
  });

  upstream.on("close", (code, reason) => {
    console.log(`Upstream closed: ${code} reason: "${reason}" — reconnecting...`);
    upstream = null;
    upstreamRetries++;
    const delay = Math.min(5000 * upstreamRetries, 30000);
    setTimeout(connectUpstream, delay);
  });

  upstream.on("error", (e) => {
    console.error("Upstream error:", e.message);
    // onclose will fire after this and handle reconnection
  });
}

// ── Browser client connections ──
wss.on("connection", (client) => {
  console.log(`Browser connected (${wss.clients.size} total, cache: ${Object.keys(vesselCache).length} vessels)`);

  client.on("close", () => {
    console.log(`Browser disconnected (${wss.clients.size} remaining)`);
  });

  client.on("error", (e) => console.error("Client error:", e.message));
});
