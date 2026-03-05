const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const API_KEY = "3e9c100a314a16a7df2a9364b1a7f8cfa775e478";
const BBOX = [[47.0, -126.5], [51.0, -121.5]];

// HTTP server handles Render health checks AND WebSocket upgrades on same port
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

  upstream.on("open", () => {
    console.log("Connected to aisstream.io — subscribing");
    upstream.send(JSON.stringify({
      Apikey: API_KEY,
      BoundingBoxes: [BBOX],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
    }));
  });

  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });

  upstream.on("close", (code, reason) => {
    console.log(`Upstream closed: ${code} ${reason}`);
    client.close();
  });

  upstream.on("error", (e) => {
    console.error("Upstream error:", e.message);
    client.close();
  });

  client.on("close", () => {
    console.log("Browser disconnected");
    upstream.close();
  });

  client.on("error", (e) => {
    console.error("Client error:", e.message);
  });
});
