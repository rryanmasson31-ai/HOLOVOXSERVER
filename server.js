const express = require("express");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");
require("dotenv").config();

const PORT = process.env.PORT || 7860;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
// const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"];
const ALLOWED_ORIGINS = ["https://holovox-rho.vercel.app", "http://localhost:3000"];
console.log("Allowed origins:", ALLOWED_ORIGINS);

if (!API_KEY || !API_SECRET || !LIVEKIT_URL) {
  console.error("❌ Missing LiveKit credentials.");
  process.exit(1);
}

console.log("✅ LiveKit credentials found:");
console.log("   URL:", LIVEKIT_URL);
console.log("   API Key:", API_KEY.slice(0, 5) + "...");
console.log("   Secret:", API_SECRET ? "present" : "missing");

// Test credentials – works with both sync and async toJwt
(async () => {
  try {
    const testToken = new AccessToken(API_KEY, API_SECRET, { identity: "test", ttl: 60 });
    testToken.addGrant({ roomJoin: true, room: "test" });
    let test;
    if (typeof testToken.toJwt === 'function' && testToken.toJwt.constructor.name === 'AsyncFunction') {
      test = await testToken.toJwt();
    } else {
      test = testToken.toJwt();
    }
    if (typeof test === "string" && test.length > 0) {
      console.log("✅ Credentials are valid.");
    } else {
      console.error("❌ Credentials are invalid. toJwt() returned:", test);
    }
  } catch (err) {
    console.error("❌ Credentials test failed:", err.message);
  }
})();

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok", livekitUrl: LIVEKIT_URL }));

app.post("/token", async (req, res) => {
  const { roomId, userId, isHost } = req.body;

  if (!roomId || !userId) {
    return res.status(400).json({ error: "Missing roomId or userId" });
  }

  const actualIsHost = !!isHost;

  try {
    const at = new AccessToken(API_KEY, API_SECRET, {
      identity: userId,
      ttl: 6 * 60 * 60,
      metadata: JSON.stringify({ isHost: actualIsHost }),
    });

    at.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    let token;
    if (typeof at.toJwt === 'function' && at.toJwt.constructor.name === 'AsyncFunction') {
      token = await at.toJwt();
    } else {
      token = at.toJwt();
    }

    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`Invalid token type: ${typeof token}`);
    }

    console.log(`✅ Token generated for ${userId} in room ${roomId}`);
    res.json({ token, url: LIVEKIT_URL });
  } catch (err) {
    console.error("❌ Token generation error:", err.message);
    console.error(err.stack);
    res.status(500).json({ error: "Token generation failed", details: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Token server running on port ${PORT}`);
});