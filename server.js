const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const API_KEY = "3e9c100a314a16a7df2a9364b1a7f8cfa775e478";
const BBOX = [[47.0, -126.5], [51.0, -121.5]];

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("AIS Proxy is running OK\n");
});

const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`AIS Proxy listening on port ${PORT}`);
});

wss.on("connection", (client) => {
  console.log("Browser connected");

  const upstream = new WebSocket(AIS_URL);
  let msgCount = 0;

  upstream.on("open", () => {
    console.log("Upstream open — sending subscription");
    const sub = {
      Apikey: API_KEY,
      BoundingBoxes: [BBOX],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
    };
    console.log("Subscription:", JSON.stringify(sub));
    upstream.send(JSON.stringify(sub));
  });

  upstream.on("message", (data) => {
    msgCount++;
    // Log first 3 messages in full so we can see errors or confirm data
    if (msgCount <= 3) {
      console.log(`Upstream msg #${msgCount}:`, data.toString().slice(0, 300));
    } else if (msgCount === 4) {
      console.log("Data flowing normally — suppressing further logs");
    }
    if (client.readyState === WebSocket.OPEN) {
      client.send(data.toString());
    }
  });

  upstream.on("close", (code, reason) => {
    console.log(`Upstream closed: ${code} reason: "${reason}"`);
    client.close();
  });

  upstream.on("error", (e) => {
    console.error("Upstream error:", e.message);
    client.close();
  });

  client.on("close", () => {
    console.log(`Browser disconnected after ${msgCount} messages`);
    upstream.close();
  });

  client.on("error", (e) => console.error("Client error:", e.message));
});
