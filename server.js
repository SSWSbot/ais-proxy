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
const MST_DATA_MAX_AGE_MS = 12 * 60 * 60 * 1000; // Skip re-polling vessels whose MST data is older than 12h
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
        dataTimestamp: new Date().toISOString(),
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
  let skippedOld = 0;
  for (const mmsi in WW_MMSI) {
    const cached = vesselCache[mmsi];

    // If we have MST data and the vessel's AIS timestamp is older than 12h,
    // it's docked/off — don't waste credits re-polling it
    if (cached && cached.source === "myshiptracking" && cached.dataTimestamp) {
      const dataAge = Date.now() - new Date(cached.dataTimestamp).getTime();
      if (dataAge > MST_DATA_MAX_AGE_MS) {
        skippedOld++;
        continue;
      }
    }

    // Include if: not in cache, OR last update was from MST (keep refreshing), OR AISstream data is stale
    if (!cached || cached.source === "myshiptracking" || cached.timestamp < cutoff) {
      stale.push(mmsi);
    }
  }
  if (skippedOld > 0) console.log(`MST poll: skipped ${skippedOld} vessels with data older than 12h`);
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
        const dataTimestamp = v.received || null; // when MST last received AIS from this vessel

        // Update cache
        vesselCache[mmsiStr] = {
          mmsi: mmsiStr,
          lat, lng, name,
          speed, heading,
          aisClass: "B",
          source: "myshiptracking",
          dataTimestamp: dataTimestamp,
          timestamp: Date.now()
        };

        // Track for diagnostics
        wwSeenMST[mmsiStr] = {
          name,
          lastSeen: new Date().toISOString(),
          lat, lng, speed, heading,
          mstTimestamp: dataTimestamp
        };

        // Broadcast to browsers as AISstream-format message
        // Include _dataTimestamp so the frontend knows the actual age of this position
        const syntheticMsg = JSON.stringify({
          MetaData: {
            MMSI: parseInt(mmsiStr),
            latitude: lat,
            longitude: lng,
            ShipName: name,
            _dataTimestamp: dataTimestamp
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

// ═══════════════════════════════════════════════════
// ── Automated Sighting Detection (WW Fleet Clustering) ──
// ═══════════════════════════════════════════════════
// Watches WW fleet vessels for proximity clustering that suggests a whale sighting.
// When 2+ WW vessels travel within 1 NM at <10 kn for >10 min, an automated
// sighting report is pushed to Firebase every 15 minutes.

const FIREBASE_DB_URL = "https://salish-sea-a97ae-default-rtdb.firebaseio.com";
const FIREBASE_API_KEY = "AIzaSyDLLmTfsBaLks6XunOKAkOiqhtYqOwnlwY"; // same web API key as frontend
// Set these in Render environment variables — a dedicated "bot" Firebase account for server writes
const FB_BOT_EMAIL = process.env.FB_BOT_EMAIL || "";
const FB_BOT_PASSWORD = process.env.FB_BOT_PASSWORD || "";
const CLUSTER_DISTANCE_NM = 1.0;       // max distance between vessels to be "close"
const CLUSTER_SPEED_MAX_KN = 10;        // vessels must be under this speed
const CLUSTER_MIN_DURATION_MS = 10 * 60 * 1000;  // 10 minutes before first report
const CLUSTER_REPORT_INTERVAL_MS = 15 * 60 * 1000; // new report every 15 min
const CLUSTER_CHECK_INTERVAL_MS = 60 * 1000;       // check every 1 minute
const CLUSTER_DATA_FRESHNESS_MS = 15 * 60 * 1000;  // vessel data must be <15 min old

// Active cluster tracking: clusterKey → { firstSeen, lastReportTime, vesselMMSIs }
const activeClusters = {};
let clusterStats = { checks: 0, clustersDetected: 0, reportsGenerated: 0, lastCheck: null, errors: 0 };

// ── Firebase Auth (bot account) ──
// Signs in via the Firebase Auth REST API to get an ID token for database writes.
// Tokens expire after ~1 hour; we refresh every 50 minutes.
let firebaseIdToken = null;
let firebaseUid = null;
let firebaseTokenExpiry = 0;

function firebaseSignIn() {
  return new Promise((resolve, reject) => {
    if (!FB_BOT_EMAIL || !FB_BOT_PASSWORD) {
      reject(new Error("FB_BOT_EMAIL / FB_BOT_PASSWORD not set — cannot authenticate with Firebase"));
      return;
    }
    const postData = JSON.stringify({
      email: FB_BOT_EMAIL,
      password: FB_BOT_PASSWORD,
      returnSecureToken: true
    });
    const url = new URL(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`);
    const options = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode === 200 && parsed.idToken) {
            firebaseIdToken = parsed.idToken;
            firebaseUid = parsed.localId || null;
            // Token expires in expiresIn seconds (usually 3600)
            const expiresIn = parseInt(parsed.expiresIn) || 3600;
            firebaseTokenExpiry = Date.now() + (expiresIn * 1000);
            console.log(`Firebase auth: signed in as ${FB_BOT_EMAIL} (uid: ${firebaseUid}), token expires in ${expiresIn}s`);
            resolve(firebaseIdToken);
          } else {
            const errMsg = parsed.error ? parsed.error.message : `HTTP ${res.statusCode}`;
            reject(new Error("Firebase sign-in failed: " + errMsg));
          }
        } catch(e) {
          reject(new Error("Firebase sign-in parse error: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// Ensure we have a valid token; refresh if expired or about to expire
async function ensureFirebaseAuth() {
  if (firebaseIdToken && Date.now() < firebaseTokenExpiry - 5 * 60 * 1000) {
    return firebaseIdToken; // still valid with 5-min buffer
  }
  return await firebaseSignIn();
}

// Start Firebase auth on boot (if credentials are set)
if (FB_BOT_EMAIL && FB_BOT_PASSWORD) {
  firebaseSignIn()
    .then(() => console.log("Firebase bot auth: READY"))
    .catch(e => console.error("Firebase bot auth FAILED:", e.message));
  // Refresh token every 50 minutes
  setInterval(() => {
    firebaseSignIn().catch(e => console.error("Firebase token refresh failed:", e.message));
  }, 50 * 60 * 1000);
} else {
  console.log("Firebase bot auth: DISABLED — set FB_BOT_EMAIL and FB_BOT_PASSWORD env vars to enable automated sighting reports");
}

// Haversine distance in nautical miles
function haversineNm(lat1, lng1, lat2, lng2) {
  const R = 3440.065; // Earth radius in NM
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2)
    + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180)
    * Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Convert heading (0-360) to compass direction string
function headingToCompass(heading) {
  if (heading == null || heading < 0 || heading >= 360) return "Milling / No Direction";
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  const idx = Math.round(heading / 45) % 8;
  return dirs[idx];
}

// Average heading from an array of headings (circular mean)
function averageHeading(headings) {
  const valid = headings.filter(h => h != null && h >= 0 && h < 360);
  if (valid.length === 0) return null;
  let sinSum = 0, cosSum = 0;
  for (const h of valid) {
    sinSum += Math.sin(h * Math.PI / 180);
    cosSum += Math.cos(h * Math.PI / 180);
  }
  let avg = Math.atan2(sinSum / valid.length, cosSum / valid.length) * 180 / Math.PI;
  if (avg < 0) avg += 360;
  return Math.round(avg);
}

// Compute centroid of a group of vessels
function clusterCenter(vessels) {
  let latSum = 0, lngSum = 0;
  for (const v of vessels) { latSum += v.lat; lngSum += v.lng; }
  return { lat: latSum / vessels.length, lng: lngSum / vessels.length };
}

// Generate a stable cluster key from sorted MMSIs
function clusterKey(mmsis) {
  return [...mmsis].sort().join("+");
}

// Push data to Firebase Realtime Database via REST API (authenticated)
async function pushToFirebase(path, data) {
  const token = await ensureFirebaseAuth();
  return new Promise((resolve, reject) => {
    const url = new URL(`${FIREBASE_DB_URL}/${path}.json?auth=${token}`);
    const postData = JSON.stringify(data);
    const options = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch(e) { resolve(body); }
        } else {
          reject(new Error(`Firebase REST ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// Generate a static map image URL showing vessel positions (CARTO tiles via staticmap service)
function generateStaticMapUrl(center, vessels) {
  // Use OpenStreetMap's static map service
  const zoom = 13;
  const w = 400, h = 250;
  // Build marker params for each vessel
  const markerParts = vessels.map(v =>
    `${v.lat},${v.lng},ol-marker`
  ).join("|");
  // Primary static map URL (openstreetmap.de service)
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${center.lat},${center.lng}&zoom=${zoom}&size=${w}x${h}&markers=${encodeURIComponent(markerParts)}&maptype=mapnik`;
}

// Get WW fleet vessels that are "underway" with fresh data
function getUnderwayWWVessels() {
  const cutoff = Date.now() - CLUSTER_DATA_FRESHNESS_MS;
  const vessels = [];
  for (const mmsi in WW_MMSI) {
    const v = vesselCache[mmsi];
    if (!v) continue;
    if (v.timestamp < cutoff) continue;            // data too old
    if (v.speed == null) continue;                  // no speed data
    if (v.speed <= 0.3) continue;                   // essentially stationary / docked
    if (v.speed >= CLUSTER_SPEED_MAX_KN) continue;  // too fast
    if (!v.lat || !v.lng) continue;
    vessels.push({
      mmsi: mmsi,
      name: WW_MMSI[mmsi] || v.name || "Unknown",
      lat: v.lat,
      lng: v.lng,
      speed: v.speed,
      heading: v.heading
    });
  }
  return vessels;
}

// Find connected components of vessels within CLUSTER_DISTANCE_NM
function findClusters(vessels) {
  const n = vessels.length;
  if (n < 2) return [];

  // Build adjacency: vessels within 1 NM of each other
  const adj = Array.from({length: n}, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i+1; j < n; j++) {
      const dist = haversineNm(vessels[i].lat, vessels[i].lng, vessels[j].lat, vessels[j].lng);
      if (dist <= CLUSTER_DISTANCE_NM) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // BFS to find connected components
  const visited = new Set();
  const clusters = [];
  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;
    if (adj[i].length === 0) continue; // isolated vessel
    const component = [];
    const queue = [i];
    visited.add(i);
    while (queue.length > 0) {
      const cur = queue.shift();
      component.push(cur);
      for (const nb of adj[cur]) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    if (component.length >= 2) {
      clusters.push(component.map(idx => vessels[idx]));
    }
  }
  return clusters;
}

// Create an automated sighting report in Firebase
async function createAutoSightingReport(clusterVessels) {
  const center = clusterCenter(clusterVessels);
  const headings = clusterVessels.map(v => v.heading);
  const avgHeading = averageHeading(headings);
  const direction = headingToCompass(avgHeading);
  const vesselNames = clusterVessels.map(v => v.name).join(", ");
  const mapUrl = generateStaticMapUrl(center, clusterVessels);

  const sighting = {
    lat: center.lat,
    lng: center.lng,
    species: "unknown_species",
    count: "Unknown",
    direction: direction,
    behaviour: "Unknown",
    source: "Automated Sighting Report. Confirmation needed",
    id: null,
    notes: "Automated report via AIS. Confirmation needed.\nVessels in cluster: " + vesselNames
      + "\nAvg heading: " + (avgHeading != null ? avgHeading + "°" : "N/A")
      + "\nSpeeds: " + clusterVessels.map(v => v.name + " " + (v.speed != null ? v.speed.toFixed(1) : "?") + "kn").join(", "),
    photo: mapUrl,
    user: "AIS",
    uid: firebaseUid || "ais-auto",
    timestamp: Date.now(),
    sightingTime: Date.now(),
    gpsLat: null,
    gpsLng: null,
    // Extra data for enhanced mini-map rendering
    _automated: true,
    _clusterVessels: clusterVessels.map(v => ({
      mmsi: v.mmsi,
      name: v.name,
      lat: v.lat,
      lng: v.lng,
      speed: v.speed,
      heading: v.heading
    }))
  };

  try {
    const result = await pushToFirebase("sightings", sighting);
    console.log(`AUTO SIGHTING: Created report at ${center.lat.toFixed(4)},${center.lng.toFixed(4)} — ${clusterVessels.length} vessels: ${vesselNames}`);
    clusterStats.reportsGenerated++;

    // Also push a chat notification
    await pushToFirebase("chat", {
      text: `Automated AIS Alert: ${clusterVessels.length} WW vessels clustered near ${center.lat.toFixed(3)}°N, ${Math.abs(center.lng).toFixed(3)}°W — ${vesselNames}. Possible sighting — confirmation needed.`,
      user: "AIS Monitor",
      uid: "system",
      timestamp: Date.now()
    }).catch(() => {}); // best-effort

    return result;
  } catch(e) {
    clusterStats.errors++;
    console.error("AUTO SIGHTING ERROR:", e.message);
    return null;
  }
}

// Main cluster check routine — runs every CLUSTER_CHECK_INTERVAL_MS
function checkForClusters() {
  clusterStats.checks++;
  clusterStats.lastCheck = new Date().toISOString();

  const underwayVessels = getUnderwayWWVessels();
  const clusters = findClusters(underwayVessels);

  // Track which existing cluster keys are still active
  const currentKeys = new Set();

  for (const cluster of clusters) {
    const mmsis = cluster.map(v => v.mmsi);
    const key = clusterKey(mmsis);
    currentKeys.add(key);

    if (!activeClusters[key]) {
      // New cluster detected — start tracking
      activeClusters[key] = {
        firstSeen: Date.now(),
        lastReportTime: 0,
        vesselMMSIs: mmsis
      };
      console.log(`CLUSTER DETECTED: ${cluster.map(v => v.name).join(", ")} — monitoring for ${CLUSTER_MIN_DURATION_MS/60000} min`);
      clusterStats.clustersDetected++;
    }

    const c = activeClusters[key];
    const age = Date.now() - c.firstSeen;
    const sinceLast = Date.now() - c.lastReportTime;

    // Has the cluster been active long enough?
    if (age >= CLUSTER_MIN_DURATION_MS) {
      // Time for a report? (first report, or 15 min since last)
      if (c.lastReportTime === 0 || sinceLast >= CLUSTER_REPORT_INTERVAL_MS) {
        c.lastReportTime = Date.now();
        createAutoSightingReport(cluster).catch(e => {
          console.error("Auto sighting report failed:", e.message);
        });
      }
    }
  }

  // Clean up clusters that no longer exist
  for (const key in activeClusters) {
    if (!currentKeys.has(key)) {
      const c = activeClusters[key];
      const duration = ((Date.now() - c.firstSeen) / 60000).toFixed(1);
      console.log(`CLUSTER ENDED: ${c.vesselMMSIs.map(m => WW_MMSI[m] || m).join(", ")} — lasted ${duration} min`);
      delete activeClusters[key];
    }
  }
}

// Start cluster monitoring after server is up (delay 2 min to let AIS data accumulate)
setTimeout(() => {
  console.log("Automated sighting detection STARTED — checking every " + (CLUSTER_CHECK_INTERVAL_MS/1000) + "s");
  checkForClusters(); // initial check
  setInterval(checkForClusters, CLUSTER_CHECK_INTERVAL_MS);
}, 2 * 60 * 1000);

// ── HTTP server ──
const server = http.createServer(async (req, res) => {
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
      autoSighting: {
        firebaseAuth: {
          botEmail: FB_BOT_EMAIL || "(not set)",
          authenticated: !!firebaseIdToken,
          uid: firebaseUid || null,
          tokenValid: firebaseIdToken && Date.now() < firebaseTokenExpiry
        },
        activeClusters: Object.keys(activeClusters).length,
        activeClusterDetails: Object.entries(activeClusters).map(([key, c]) => ({
          vessels: c.vesselMMSIs.map(m => WW_MMSI[m] || m),
          ageMinutes: ((Date.now() - c.firstSeen) / 60000).toFixed(1),
          lastReport: c.lastReportTime ? new Date(c.lastReportTime).toISOString() : "none yet"
        })),
        ...clusterStats
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

  // ── TEST CLUSTER ENDPOINT ──
  // Injects fake WW vessel positions near each other and triggers cluster detection.
  // Usage: GET /api/test-cluster  (or ?cleanup=1 to remove test data after)
  if (req.method === "GET" && req.url.startsWith("/api/test-cluster")) {
    const cleanup = req.url.includes("cleanup=1");

    // Pick 3 real WW fleet MMSIs to simulate
    const testMMSIs = ["316034816", "316042213", "316032858"]; // WILD 4 WHALES, SALISH SEA FREEDOM, SALISH SEA DREAM
    const testCenter = { lat: 48.5155, lng: -123.0075 }; // Off San Juan Island

    // Save originals so we can restore them
    const originals = {};
    for (const mmsi of testMMSIs) {
      originals[mmsi] = vesselCache[mmsi] ? { ...vesselCache[mmsi] } : null;
    }

    // Inject fake positions: 3 vessels ~0.3 NM apart, all going ~5 kn heading NW
    const offsets = [
      { dLat: 0.0,    dLng: 0.0,    speed: 4.8, heading: 315 },
      { dLat: 0.003,  dLng: -0.002, speed: 5.2, heading: 310 },
      { dLat: -0.002, dLng: 0.003,  speed: 4.5, heading: 320 }
    ];

    for (let i = 0; i < testMMSIs.length; i++) {
      const mmsi = testMMSIs[i];
      const o = offsets[i];
      vesselCache[mmsi] = {
        mmsi: mmsi,
        lat: testCenter.lat + o.dLat,
        lng: testCenter.lng + o.dLng,
        name: WW_MMSI[mmsi] || "Test Vessel",
        speed: o.speed,
        heading: o.heading,
        aisClass: "B",
        source: "test-cluster",
        dataTimestamp: new Date().toISOString(),
        timestamp: Date.now()
      };
    }

    // Force-create a cluster entry that's already been tracking for 11 min
    // (past the 10-min threshold) so the report fires immediately
    const key = clusterKey(testMMSIs);
    activeClusters[key] = {
      firstSeen: Date.now() - (CLUSTER_MIN_DURATION_MS + 60000), // 11 min ago
      lastReportTime: 0,
      vesselMMSIs: testMMSIs
    };

    // Run cluster check — this will detect the cluster and create the sighting
    let reportResult = null;
    let reportError = null;
    try {
      // Check auth first
      if (!FB_BOT_EMAIL || !FB_BOT_PASSWORD) {
        throw new Error("FB_BOT_EMAIL and FB_BOT_PASSWORD env vars not set. Create a Firebase account for the bot and set these in Render.");
      }
      // Ensure we have a valid token
      await ensureFirebaseAuth();
      if (!firebaseIdToken) {
        throw new Error("Firebase auth token is null — sign-in may have failed. Check FB_BOT_EMAIL / FB_BOT_PASSWORD.");
      }

      // Directly create the report instead of relying on async checkForClusters
      const clusterVessels = testMMSIs.map(mmsi => ({
        mmsi,
        name: WW_MMSI[mmsi] || "Test Vessel",
        lat: vesselCache[mmsi].lat,
        lng: vesselCache[mmsi].lng,
        speed: vesselCache[mmsi].speed,
        heading: vesselCache[mmsi].heading
      }));

      reportResult = await createAutoSightingReport(clusterVessels);
      if (reportResult === null) {
        reportError = "createAutoSightingReport returned null — check server logs for details";
      } else {
        activeClusters[key].lastReportTime = Date.now();
      }
    } catch(e) {
      reportError = e.message;
    }

    // Optionally clean up: restore original cache entries & remove cluster
    if (cleanup) {
      for (const mmsi of testMMSIs) {
        if (originals[mmsi]) {
          vesselCache[mmsi] = originals[mmsi];
        } else {
          delete vesselCache[mmsi];
        }
      }
      delete activeClusters[key];
    }

    const response = {
      success: !reportError,
      message: reportError
        ? "Test cluster injected but report FAILED: " + reportError
        : "Test cluster injected and sighting report created",
      auth: {
        botEmail: FB_BOT_EMAIL || "(not set)",
        botPasswordSet: !!FB_BOT_PASSWORD,
        firebaseUid: firebaseUid || null,
        tokenValid: firebaseIdToken && Date.now() < firebaseTokenExpiry,
        tokenExpiry: firebaseTokenExpiry ? new Date(firebaseTokenExpiry).toISOString() : null
      },
      error: reportError || null,
      testVessels: testMMSIs.map(mmsi => ({
        mmsi,
        name: WW_MMSI[mmsi],
        lat: vesselCache[mmsi] ? vesselCache[mmsi].lat : "cleaned up",
        lng: vesselCache[mmsi] ? vesselCache[mmsi].lng : "cleaned up",
        speed: vesselCache[mmsi] ? vesselCache[mmsi].speed : null
      })),
      clusterKey: key,
      clusterActive: !!activeClusters[key],
      firebaseResult: reportResult,
      cleanup: cleanup,
      hint: reportError
        ? "Fix the error above, redeploy, and try again."
        : cleanup
          ? "Test data cleaned up. Check your app — the sighting should appear on the map."
          : "Test data still in cache. Call /api/test-cluster?cleanup=1 to remove, or it will expire naturally."
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response, null, 2));
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
      mstCreditsUsed: mstStats.creditsUsed,
      activeClusters: Object.keys(activeClusters).length,
      autoReportsGenerated: clusterStats.reportsGenerated
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
