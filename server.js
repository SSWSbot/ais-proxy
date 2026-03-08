const http = require("http");
const https = require("https");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const API_KEY = "3e9c100a314a16a7df2a9364b1a7f8cfa775e478";
const BBOX = [[47.0, -126.5], [51.0, -121.5]];

// ── MyShipTracking config (second AIS source for WW Fleet) ──
// Set MST_API_KEY in Render environment variables
const MST_KEY = process.env.MST_API_KEY || "";
const MST_POLL_INTERVAL_MS = 5 * 60 * 1000;   // Poll every 5 minutes
const MST_STALE_THRESHOLD_MS = 15 * 60 * 1000; // Only poll MMSIs not seen by AISstream in 15 min
const MST_BATCH_SIZE = 100;                     // Max MMSIs per MyShipTracking bulk request

// ── WW Fleet MMSI list (mirrored from frontend for diagnostics) ──
const WW_MMSI = {
  "369264000":"ISLAND EXPLORER 5","368023510":"SARATOGA","338519000":"SWIFTSURE",
  "367156000":"CHILKAT EXPRESS","367121000":"GLACIER SPIRIT","316039686":"SALISH SEA ECLIPSE",
  "366889850":"RED HEAD","316034816":"WILD 4 WHALES","316042213":"SALISH SEA FREEDOM",
  "368026630":"WESTERN EXPLORER II","316032858":"SALISH SEA DREAM","316008046":"EXPLORATHOR II",
  "338576000":"OSPREY","367784930":"BLACKFISH IV","316008045":"EXPLORATHOR EXPRESS",
  "367524220":"BLACKFISH II","316042661":"KULA","316028179":"4 EVER WILD",
  "316036809":"CASCADIA","367091440":"VICTORIA STAR 2","316018618":"ORCA SPIRIT II",
  "367014000":"KESTREL","367742760":"J1","367351090":"ODYSSEY",
  "368032220":"J2","338191000":"SEA LION","316007107":"GOLDWING",
  "316035167":"STRIDER I","368616000":"BLACKFISH VI","367679710":"BLACKFISH",
  "316004449":"THE EMPRESS","316010956":"PACIFIC EXPLORER I","368295070":"SOUNDER",
  "316032442":"JING YU","316009175":"SONIC","316040366":"AURORA II",
  "316034894":"EAGLE EYES","368355000":"PELAGIC II","316008331":"OCEAN MAGIC II",
  "338562000":"WESTERN PRINCE II","316029172":"ORCA MIST","369329000":"SALISH EXPRESS",
  "316006789":"OCEAN MAGIC","316004386":"TAKU","368111540":"PENIEL",
  "316004458":"QUEEN OF HEARTS","316041693":"SPARTAN01","367395870":"SALISH SEA",
  "316004946":"MARAUDER IV","316004457":"JESTER","316034303":"SEABREEZE I",
  "316008708":"KULUTA","316051368":"WILDCAT 4","316008468":"SERENGETI",
  "367679690":"TRITON","316004641":"FASTTIDE","367631000":"SQUITO",
  "316005009":"PACIFIC DANCER","316040487":"AURORA I","316004455":"THE COUNTESS",
  "316007101":"SPY HOPPER","316004448":"HER MAJESTY","316023189":"BC TIKA",
  "316036225":"KETA","316014609":"LIGHTSHIP 1","316004456":"LADY DI",
  "316014426":"CRAZY LEGS","316020635":"BC ORCA","367753310":"DFW RESEARCH VESSEL",
  "316004454":"THE DUCHESS","316041457":"ONYX","316009063":"ACHIEVER",
  "316039308":"SKANA","316046383":"KLOHOY","316040353":"POSEIDONS CHARIOT",
  "338203383":"SPIRIT OF ORCA","316006873":"EMERALD MOON","316049389":"PROWLER",
  "316003689":"KKO","316003705":"FIVE STAR SUPERCAT","316047889":"ECHO",
  "338209422":"KODIAK","316014948":"TENACIOUS III","316041672":"IKAIKA",
  "316007866":"TRIPLE 8","316050913":"SPARTAN 2","316006859":"HAISLA EXPLORER",
  "338470525":"T2","316005064":"ORCA SPIRIT","316049353":"COOPER POINT",
  "338433231":"GALLIANO","316056299":"CEMORE","316004338":"TRIPLE 8 II",
  "316004451":"THE MYSTERY","338433228":"BLACKMOUTH"
};

// ── Vessel position cache ──
const vesselCache = {};
const CACHE_TTL_MS = 30 * 60 * 1000;

// ── Diagnostics tracking ──
const messageTypeCounts = {};
const wwSeen = {};       // tracks AISstream sightings
const wwSeenMST = {};    // tracks MyShipTracking sightings
let totalMessages = 0;
let upstreamConnectedAt = null;
let mstStats = { polls: 0, creditsUsed: 0, vesselsQueried: 0, vesselsReturned: 0, errors: 0, lastPoll: null };

// Clean stale cache entries every 5 minutes
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
    const mmsiStr = String(mmsi);

    let lat = meta.latitude || meta.Latitude;
    let lng = meta.longitude || meta.Longitude;
    let name = (meta.ShipName || meta.ship_name || "").trim();
    let speed = null, heading = null;
    let aisClass = null;
    let msgType = null;

    if (msg.Message) {
      // Track every message type we receive from AISstream
      const msgKeys = Object.keys(msg.Message);
      msgKeys.forEach(k => {
        msgType = msgType || k;
        messageTypeCounts[k] = (messageTypeCounts[k] || 0) + 1;
      });

      let p = {};
      if (msg.Message.PositionReport) {
        p = msg.Message.PositionReport;
        aisClass = "A";
      } else if (msg.Message.StandardClassBPositionReport) {
        p = msg.Message.StandardClassBPositionReport;
        aisClass = "B";
      }

      if (p.Latitude  != null) lat = p.Latitude;
      if (p.Longitude != null) lng = p.Longitude;
      if (p.Sog != null) speed = p.Sog;
      if (p.TrueHeading != null && p.TrueHeading < 360) heading = p.TrueHeading;
      if (heading == null && p.Cog != null && p.Cog < 360) heading = Math.round(p.Cog);

      const s = msg.Message.ShipStaticData || {};
      if (s.Name) name = s.Name.trim();
    }

    // ── WW Fleet tracking ──
    if (WW_MMSI[mmsiStr]) {
      const isFirst = !wwSeen[mmsiStr];
      wwSeen[mmsiStr] = {
        name: name || WW_MMSI[mmsiStr],
        lastSeen: new Date().toISOString(),
        aisClass: aisClass || (wwSeen[mmsiStr] && wwSeen[mmsiStr].aisClass) || null,
        msgType: msgType,
        lat: lat || null,
        lng: lng || null,
        count: ((wwSeen[mmsiStr] && wwSeen[mmsiStr].count) || 0) + 1
      };
      if (isFirst) {
        console.log(`WW FLEET SPOTTED: ${WW_MMSI[mmsiStr]} (${mmsiStr}) class=${aisClass} type=${msgType} pos=${lat},${lng}`);
      }
    }

    if (lat && lng) {
      const prev = vesselCache[mmsiStr];
      vesselCache[mmsiStr] = {
        mmsi: mmsiStr,
        lat, lng, name,
        speed:   speed   != null ? speed   : null,
        heading: heading != null ? heading : null,
        aisClass: aisClass || (prev && prev.aisClass) || null,
        source: "aisstream",
        timestamp: Date.now()
      };
    }
  } catch (e) {
    // Ignore malformed messages
  }
}

// ═══════════════════════════════════════════════════
// ── MyShipTracking Poller (second AIS source for WW Fleet) ──
// ═══════════════════════════════════════════════════
// Only queries WW fleet vessels that AISstream hasn't delivered recently.
// This saves credits — we only pay for vessels MST actually finds.

function getStaleWWMMSIs() {
  const cutoff = Date.now() - MST_STALE_THRESHOLD_MS;
  const stale = [];
  for (const mmsi in WW_MMSI) {
    const cached = vesselCache[mmsi];
    // Include if: not in cache, OR last update was from MST (keep refreshing), OR AISstream data is stale
    if (!cached || cached.source === "myshiptracking" || cached.timestamp < cutoff) {
      stale.push(mmsi);
    }
  }
  return stale;
}

function fetchMST(mmsiList) {
  return new Promise((resolve, reject) => {
    const url = `https://api.myshiptracking.com/api/v2/vessel/bulk?mmsi=${mmsiList.join(",")}`;
    const options = {
      headers: { "Authorization": `Bearer ${MST_KEY}` }
    };
    https.get(url, options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`MST API returned ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          // MST wraps data in { status, data: [...] }
          if (parsed.status === "success" && Array.isArray(parsed.data)) {
            // Check credit header
            const charged = res.headers["x-credit-charged"];
            if (charged) mstStats.creditsUsed += parseInt(charged) || 0;
            resolve(parsed.data);
          } else if (parsed.status === "error") {
            reject(new Error("MST error: " + (parsed.message || JSON.stringify(parsed))));
          } else {
            resolve([]);
          }
        } catch (e) {
          reject(new Error("MST JSON parse error: " + e.message));
        }
      });
    }).on("error", reject);
  });
}

async function pollMST() {
  if (!MST_KEY) return;

  const staleMMSIs = getStaleWWMMSIs();
  if (staleMMSIs.length === 0) {
    console.log("MST poll: all WW vessels covered by AISstream, skipping.");
    return;
  }

  // Split into batches of 100
  const batches = [];
  for (let i = 0; i < staleMMSIs.length; i += MST_BATCH_SIZE) {
    batches.push(staleMMSIs.slice(i, i + MST_BATCH_SIZE));
  }

  console.log(`MST poll: querying ${staleMMSIs.length} stale WW vessels in ${batches.length} batch(es)...`);
  mstStats.polls++;
  mstStats.lastPoll = new Date().toISOString();

  for (const batch of batches) {
    try {
      mstStats.vesselsQueried += batch.length;
      const results = await fetchMST(batch);
      if (!Array.isArray(results)) continue;

      let count = 0;
      for (const v of results) {
        const mmsiStr = String(v.mmsi);
        const lat = v.lat;
        const lng = v.lng;
        if (!lat || !lng) continue;

        // Skip if AISstream delivered a fresher update since we started
        const existing = vesselCache[mmsiStr];
        if (existing && existing.source === "aisstream" && existing.timestamp > Date.now() - MST_STALE_THRESHOLD_MS) {
          continue;
        }

        const heading = (v.course != null && v.course < 360) ? Math.round(v.course) : null;
        const speed = v.speed != null ? v.speed : null;
        const name = v.vessel_name || WW_MMSI[mmsiStr] || "Unknown";

        // Update cache
        vesselCache[mmsiStr] = {
          mmsi: mmsiStr,
          lat, lng, name,
          speed, heading,
          aisClass: "B",
          source: "myshiptracking",
          timestamp: Date.now()
        };

        // Track for diagnostics
        wwSeenMST[mmsiStr] = {
          name,
          lastSeen: new Date().toISOString(),
          lat, lng, speed, heading,
          mstTimestamp: v.received || null
        };

        // Broadcast to browsers as AISstream-format message
        const syntheticMsg = JSON.stringify({
          MetaData: {
            MMSI: parseInt(mmsiStr),
            latitude: lat,
            longitude: lng,
            ShipName: name
          },
          Message: {
            PositionReport: {
              Latitude: lat,
              Longitude: lng,
              Sog: speed,
              TrueHeading: heading != null ? heading : 511,
              Cog: v.course != null ? v.course : 360
            }
          }
        });
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(syntheticMsg);
          }
        });

        count++;
      }

      mstStats.vesselsReturned += count;
      if (count > 0) {
        console.log(`MST poll: got ${count} positions (batch of ${batch.length}). Total credits used: ~${mstStats.creditsUsed}`);
      }
    } catch (e) {
      mstStats.errors++;
      console.error("MST poll error:", e.message);
    }
  }
}

// Start MyShipTracking polling
if (MST_KEY) {
  console.log("MyShipTracking integration ENABLED — polling every " + (MST_POLL_INTERVAL_MS / 60000) + " min");
  // First poll after 30 seconds (let AISstream populate first)
  setTimeout(pollMST, 30 * 1000);
  setInterval(pollMST, MST_POLL_INTERVAL_MS);
} else {
  console.log("MyShipTracking integration DISABLED — set MST_API_KEY env var to enable");
}

// ── HTTP server ──
const server = http.createServer((req, res) => {
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

  // ── DIAGNOSTIC ENDPOINT ──
  if (req.method === "GET" && req.url === "/api/debug") {
    const wwTotal = Object.keys(WW_MMSI).length;
    const wwSeenList = [];
    const wwMissingList = [];

    for (const mmsi in WW_MMSI) {
      const fromAIS = wwSeen[mmsi] || null;
      const fromMST = wwSeenMST[mmsi] || null;
      const inCache = vesselCache[mmsi] || null;
      if (fromAIS || fromMST || inCache) {
        wwSeenList.push({
          mmsi, name: WW_MMSI[mmsi],
          ...(fromAIS || {}),
          myShipTracking: fromMST || null,
          cacheSource: inCache ? inCache.source : null
        });
      } else {
        wwMissingList.push({ mmsi, name: WW_MMSI[mmsi] });
      }
    }

    wwSeenList.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
    wwMissingList.sort((a, b) => a.name.localeCompare(b.name));

    const result = {
      summary: {
        totalMessagesReceived: totalMessages,
        uniqueVesselsInCache: Object.keys(vesselCache).length,
        upstreamConnected: upstream && upstream.readyState === WebSocket.OPEN,
        upstreamConnectedAt: upstreamConnectedAt,
        uptimeMinutes: upstreamConnectedAt ? Math.round((Date.now() - new Date(upstreamConnectedAt).getTime()) / 60000) : null
      },
      messageTypes: messageTypeCounts,
      myShipTracking: {
        enabled: !!MST_KEY,
        pollIntervalMin: MST_POLL_INTERVAL_MS / 60000,
        ...mstStats
      },
      wwFleet: {
        total: wwTotal,
        seen: wwSeenList.length,
        seenByAISstream: Object.keys(wwSeen).length,
        seenByMyShipTracking: Object.keys(wwSeenMST).length,
        missing: wwMissingList.length,
        seenVessels: wwSeenList,
        missingVessels: wwMissingList
      }
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // Health check
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      vessels: Object.keys(vesselCache).length,
      wwSeen: Object.keys(wwSeen).length,
      wwSeenMST: Object.keys(wwSeenMST).length,
      wwTotal: Object.keys(WW_MMSI).length,
      upstreamConnected: upstream && upstream.readyState === WebSocket.OPEN,
      myShipTrackingEnabled: !!MST_KEY,
      mstCreditsUsed: mstStats.creditsUsed
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
  console.log(`WW Fleet: tracking ${Object.keys(WW_MMSI).length} vessels`);
  connectUpstream();
});

// ── Shared upstream AIS connection ──
let upstream = null;
let upstreamRetries = 0;

function connectUpstream() {
  console.log("Connecting to upstream AIS...");
  upstream = new WebSocket(AIS_URL);

  upstream.on("open", () => {
    upstreamRetries = 0;
    totalMessages = 0;
    upstreamConnectedAt = new Date().toISOString();
    console.log("Upstream open — sending subscription");
    const sub = {
      Apikey: API_KEY,
      BoundingBoxes: [BBOX]
    };
    console.log("Subscription:", JSON.stringify(sub));
    upstream.send(JSON.stringify(sub));
  });

  upstream.on("message", (data) => {
    const raw = data.toString();
    totalMessages++;

    if (totalMessages <= 5) {
      console.log(`Upstream msg #${totalMessages}:`, raw.slice(0, 400));
    } else if (totalMessages === 6) {
      console.log("Data flowing — check /api/debug for diagnostics.");
    }

    if (totalMessages % 1000 === 0) {
      console.log(`${totalMessages} msgs | Cache: ${Object.keys(vesselCache).length} vessels | WW seen: ${Object.keys(wwSeen).length}/${Object.keys(WW_MMSI).length} | Types: ${JSON.stringify(messageTypeCounts)}`);
    }

    updateCache(raw);

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
  });
}

// ── Browser client connections ──
wss.on("connection", (client) => {
  console.log(`Browser connected (${wss.clients.size} total, cache: ${Object.keys(vesselCache).length} vessels, WW seen: ${Object.keys(wwSeen).length})`);

  client.on("close", () => {
    console.log(`Browser disconnected (${wss.clients.size} remaining)`);
  });

  client.on("error", (e) => console.error("Client error:", e.message));
});
