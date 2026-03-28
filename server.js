import express from "express";
import cors from "cors";
import { AccessToken } from "livekit-server-sdk";

const app = express();

app.use(cors());
app.use(express.json());

// 🔥 ENV VARIABLES (use Railway ENV later)
const API_KEY = process.env.LIVEKIT_API_KEY || "YOUR_API_KEY";
const API_SECRET = process.env.LIVEKIT_API_SECRET || "YOUR_API_SECRET";
const LIVEKIT_URL = process.env.LIVEKIT_URL || "wss://your-livekit-url";

app.get("/", (req, res) => {
  res.send("LiveKit Server Running");
});

// 🔥 TOKEN GENERATION (MAIN ENDPOINT)
app.post("/get-token", (req, res) => {
  const { roomName, identity } = req.body;

  if (!roomName || !identity) {
    return res.status(400).json({ error: "Missing roomName or identity" });
  }

  const token = new AccessToken(API_KEY, API_SECRET, {
    identity,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  res.json({
    token: token.toJwt(),
    url: LIVEKIT_URL,
  });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});