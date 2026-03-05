const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const API_KEY = "3e9c100a314a16a7df2a9364b1a7f8cfa775e478";
const BBOX = [[47.0, -126.5], [51.0, -121.5]];

const wss = new WebSocket.Server({ port: PORT });
console.log(`AIS Proxy listening on port ${PORT}`);

wss.on("connection", (client) => {
  console.log("Browser connected");
  const upstream = new WebSocket(AIS_URL);

  upstream.on("open", () => {
    console.log("Upstream open — sending subscription");
    // Proxy sends the subscription itself — no race condition
    upstream.send(JSON.stringify({
      Apikey: API_KEY,
      BoundingBoxes: [BBOX],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
    }));
  });

  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });

  upstream.on("close", () => client.close());
  upstream.on("error", (e) => { console.error("Upstream error:", e.message); client.close(); });
  client.on("close", () => upstream.close());
  client.on("error", (e) => console.error("Client error:", e.message));
});
