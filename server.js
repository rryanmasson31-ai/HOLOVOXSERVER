// server.js
const express = require("express");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");
require("dotenv").config();

const PORT = process.env.PORT || 7860;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"];

if (!API_KEY || !API_SECRET || !LIVEKIT_URL) {
  console.error("❌ Missing LiveKit credentials.");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok", livekitUrl: LIVEKIT_URL }));

app.post("/token", async (req, res) => {
  const { roomId, userId, isHost } = req.body;

  if (!roomId || !userId) {
    return res.status(400).json({ error: "Missing roomId or userId" });
  }

  // 🔐 In production, determine host from your database.
  // For now, we accept the client's claim.
  const actualIsHost = !!isHost;

  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: userId,
    ttl: 6 * 60 * 60, // 6 hours
    metadata: JSON.stringify({ isHost: actualIsHost }),
  });

  at.addGrant({
    roomJoin: true,
    room: roomId,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = at.toJwt();
  res.json({ token, url: LIVEKIT_URL });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Token server running on port ${PORT}`);
  console.log(`   LiveKit URL: ${LIVEKIT_URL}`);
  console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});