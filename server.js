const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const AIS_URL = "wss://stream.aisstream.io/v0/stream";

const wss = new WebSocket.Server({ port: PORT });

console.log(`AIS Proxy listening on port ${PORT}`);

wss.on("connection", (client) => {
  console.log("Browser connected");

  let messageBuffer = [];
  const upstream = new WebSocket(AIS_URL);

  upstream.on("open", () => {
    console.log("Connected to aisstream.io");
    // Send any messages that arrived before upstream was ready
    messageBuffer.forEach(msg => upstream.send(msg));
    messageBuffer = [];
  });

  // Forward messages from aisstream → browser
  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });

  // Forward messages from browser → aisstream
  // Buffer them if upstream isn't open yet
  client.on("message", (data) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data);
    } else {
      messageBuffer.push(data);
    }
  });

  upstream.on("close", () => client.close());
  upstream.on("error", (e) => {
    console.error("Upstream error:", e.message);
    client.close();
  });

  client.on("close", () => upstream.close());
  client.on("error", (e) => console.error("Client error:", e.message));
});
