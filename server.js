/**
 * LiveKit Signaling Server
 * 
 * This server handles:
 * 1. WebSocket connections for real-time signaling
 * 2. JWT token generation for LiveKit authentication
 * 3. Room management (create, join, leave)
 * 4. Participant tracking
 * 5. Host transfer logic
 * 6. Health monitoring endpoints
 */

const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const express = require("express");
const cors = require("cors");
const http = require("http");
require("dotenv").config();

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 7860;

// LiveKit Cloud credentials - MUST be set in environment variables
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

// Validate required environment variables
if (!API_KEY || !API_SECRET || !LIVEKIT_URL) {
  console.error("\n❌ ERROR: Missing required environment variables!");
  console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.error("Please set the following in your environment:");
  console.error("  - LIVEKIT_URL      (e.g., wss://your-project.livekit.cloud)");
  console.error("  - LIVEKIT_API_KEY  (from LiveKit Cloud dashboard)");
  console.error("  - LIVEKIT_API_SECRET (from LiveKit Cloud dashboard)");
  console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  process.exit(1);
}

// ==================== DATA STRUCTURES ====================
// Using Map for better performance with large number of rooms/participants
const rooms = new Map(); // roomId -> { hostId, participants (Map), createdAt }

// Room structure:
// {
//   hostId: string,
//   participants: Map(userId -> WebSocket),
//   createdAt: timestamp
// }

// ==================== EXPRESS SETUP ====================
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server (will be used for both Express and WebSocket)
const server = http.createServer(app);

// ==================== WEBSOCKET SERVER ====================
const wss = new WebSocket.Server({ 
  server,
  path: '/ws',  // WebSocket endpoint
  perMessageDeflate: false,  // Disable for lower latency
  maxPayload: 256 * 1024,    // 256KB max message size
  clientTracking: true,
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Send message to a specific client
 */
function sendToClient(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (error) {
      console.error("Error sending to client:", error.message);
    }
  }
}

/**
 * Broadcast message to all participants in a room except sender
 */
function broadcastToRoom(roomId, senderId, data) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.participants.forEach((ws, userId) => {
    if (userId !== senderId && ws.readyState === WebSocket.OPEN) {
      sendToClient(ws, data);
    }
  });
}

/**
 * Generate JWT token for LiveKit authentication
 * Token includes:
 * - User identity and metadata
 * - Room join permissions
 * - Token expiry (6 hours)
 */
function generateLiveKitToken(roomName, userId, isHost) {
  try {
    const token = jwt.sign(
      {
        // Issuer (API Key)
        iss: API_KEY,
        
        // Expiration (6 hours from now)
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 6,
        
        // Not valid before (current time)
        nbf: Math.floor(Date.now() / 1000),
        
        // User identity
        sub: userId,
        
        // Video permissions
        video: {
          room: roomName,
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
        },
        
        // Custom metadata for client
        metadata: JSON.stringify({ 
          isHost, 
          userId,
          role: isHost ? 'host' : 'participant'
        }),
      },
      API_SECRET,
      { algorithm: 'HS256' }
    );
    
    return token;
  } catch (error) {
    console.error("Error generating token:", error);
    throw new Error("Failed to generate LiveKit token");
  }
}

/**
 * Clean up empty rooms
 */
function cleanupEmptyRooms() {
  const now = Date.now();
  const CLEANUP_DELAY = 5 * 60 * 1000; // 5 minutes
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.size === 0) {
      // Room is empty, check if it should be cleaned
      if (now - room.createdAt > CLEANUP_DELAY) {
        rooms.delete(roomId);
        console.log(`🧹 Cleaned up empty room: ${roomId}`);
      }
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupEmptyRooms, 10 * 60 * 1000);

// ==================== HTTP ENDPOINTS ====================

/**
 * Health check endpoint
 * Used by Railway/Vercel for monitoring
 */
app.get('/health', (req, res) => {
  const totalParticipants = Array.from(rooms.values())
    .reduce((sum, room) => sum + room.participants.size, 0);
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
    stats: {
      activeRooms: rooms.size,
      totalParticipants: totalParticipants,
      livekitUrl: LIVEKIT_URL
    }
  });
});

/**
 * Get room information (for debugging)
 */
app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ 
      error: 'Room not found',
      roomId 
    });
  }
  
  res.json({
    roomId,
    hostId: room.hostId,
    participantCount: room.participants.size,
    participants: Array.from(room.participants.keys()),
    createdAt: new Date(room.createdAt).toISOString(),
    age: Math.floor((Date.now() - room.createdAt) / 1000) // seconds
  });
});

/**
 * List all active rooms (for monitoring)
 */
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([id, room]) => ({
    roomId: id,
    participantCount: room.participants.size,
    hostId: room.hostId,
    createdAt: new Date(room.createdAt).toISOString()
  }));
  
  res.json({
    totalRooms: roomList.length,
    rooms: roomList
  });
});

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.json({
    name: 'LiveKit Signaling Server',
    version: '1.0.0',
    description: 'WebRTC signaling server for 360° meeting platform',
    endpoints: {
      websocket: 'ws://host/ws',
      health: 'GET /health',
      rooms: 'GET /api/rooms',
      room: 'GET /api/rooms/:roomId'
    },
    documentation: 'https://github.com/yourusername/livekit-signaling-server'
  });
});

// ==================== WEBSOCKET CONNECTION HANDLER ====================

wss.on("connection", (ws, req) => {
  // Client-specific data
  let roomId = null;
  let userId = null;
  let isHost = false;
  
  // Set up heartbeat to detect dead connections
  ws.isAlive = true;
  ws.on('pong', () => { 
    ws.isAlive = true; 
  });

  console.log(`🔌 New WebSocket connection from ${req.socket.remoteAddress}`);
  
  /**
   * Handle incoming messages from client
   */
  ws.on("message", async (msg) => {
    // Parse JSON message
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.error("Invalid JSON message:", msg.toString().substring(0, 100));
      sendToClient(ws, { 
        type: "error", 
        message: "Invalid message format. JSON required." 
      });
      return;
    }
    
    // Handle different message types
    switch(data.type) {
      
      /**
       * PING - Heartbeat message
       * Client sends ping, server responds with pong
       */
      case "ping":
        sendToClient(ws, { 
          type: "pong", 
          userId: data.userId, 
          timestamp: Date.now() 
        });
        break;
      
      /**
       * JOIN - User joins a room
       * Creates room if doesn't exist, generates token, notifies others
       */
      case "join":
        roomId = data.roomId;
        userId = data.userId;
        isHost = data.isHost || false;
        
        // Validate required fields
        if (!roomId || !userId) {
          sendToClient(ws, { 
            type: "error", 
            message: "Missing roomId or userId" 
          });
          return;
        }
        
        console.log(`\n📥 JOIN REQUEST:`);
        console.log(`   Room: ${roomId}`);
        console.log(`   User: ${userId}`);
        console.log(`   Role: ${isHost ? 'HOST' : 'PARTICIPANT'}`);
        
        // Get or create room
        let room = rooms.get(roomId);
        if (!room) {
          room = {
            hostId: null,
            participants: new Map(),
            createdAt: Date.now()
          };
          rooms.set(roomId, room);
          console.log(`   ✨ Created new room: ${roomId}`);
        }
        
        // Handle host assignment
        if (isHost) {
          // If room already has a host, warn but allow multiple hosts?
          if (room.hostId && room.hostId !== userId) {
            console.log(`   ⚠️ Room ${roomId} already has host: ${room.hostId}`);
          }
          room.hostId = userId;
          console.log(`   👑 User ${userId} is now host`);
        }
        
        // Add participant to room
        room.participants.set(userId, ws);
        console.log(`   👥 Room now has ${room.participants.size} participants`);
        
        // Generate LiveKit token for this user
        try {
          const token = generateLiveKitToken(roomId, userId, isHost);
          
          // Send token to the joining user
          sendToClient(ws, {
            type: "ready",
            url: LIVEKIT_URL,
            token: token,
            roomId: roomId,
            userId: userId,
            isHost: isHost,
            timestamp: Date.now()
          });
          
          console.log(`   ✅ Token generated and sent to ${userId}`);
          
        } catch (error) {
          console.error(`   ❌ Failed to generate token:`, error);
          sendToClient(ws, {
            type: "error",
            message: "Failed to authenticate with LiveKit"
          });
          return;
        }
        
        // Notify existing participants about new user
        broadcastToRoom(roomId, userId, { 
          type: "user-joined", 
          userId, 
          isHost,
          timestamp: Date.now()
        });
        
        // Send existing participants list to the new user
        const existingParticipants = Array.from(room.participants.entries())
          .filter(([id]) => id !== userId)
          .map(([id, _]) => ({
            userId: id,
            isHost: room.hostId === id
          }));
        
        if (existingParticipants.length > 0) {
          sendToClient(ws, {
            type: "existing-participants",
            participants: existingParticipants,
            hostId: room.hostId
          });
          console.log(`   📋 Sent existing participants: ${existingParticipants.length}`);
        }
        
        break;
      
      /**
       * LEAVE - User leaves a room
       * Remove from room, notify others, handle host transfer
       */
      case "leave":
        if (roomId && rooms.has(roomId)) {
          const room = rooms.get(roomId);
          const wasRemoved = room.participants.delete(userId);
          
          if (wasRemoved) {
            console.log(`👋 User ${userId} left room ${roomId}`);
            
            // Notify other participants
            broadcastToRoom(roomId, userId, { 
              type: "user-left", 
              userId,
              timestamp: Date.now()
            });
            
            // Handle host leaving
            if (room.hostId === userId) {
              const participants = Array.from(room.participants.keys());
              if (participants.length > 0) {
                // Assign first participant as new host
                const newHostId = participants[0];
                room.hostId = newHostId;
                
                // Notify everyone about host change
                broadcastToRoom(roomId, null, { 
                  type: "host-changed", 
                  newHostId: newHostId,
                  timestamp: Date.now()
                });
                
                console.log(`   👑 Host transferred to: ${newHostId}`);
              } else {
                room.hostId = null;
                console.log(`   👑 No host remaining`);
              }
            }
          }
        }
        break;
      
      /**
       * Unknown message type
       */
      default:
        console.log(`⚠️ Unknown message type: ${data.type} from ${userId}`);
        sendToClient(ws, { 
          type: "error", 
          message: `Unknown message type: ${data.type}` 
        });
    }
  });
  
  /**
   * Handle WebSocket close
   */
  ws.on("close", () => {
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const wasRemoved = room.participants.delete(userId);
      
      if (wasRemoved) {
        console.log(`🔌 User ${userId} disconnected from room ${roomId}`);
        
        // Notify other participants
        broadcastToRoom(roomId, userId, { 
          type: "user-left", 
          userId,
          timestamp: Date.now()
        });
        
        // Handle host leaving
        if (room.hostId === userId) {
          const participants = Array.from(room.participants.keys());
          if (participants.length > 0) {
            const newHostId = participants[0];
            room.hostId = newHostId;
            
            broadcastToRoom(roomId, null, { 
              type: "host-changed", 
              newHostId: newHostId,
              timestamp: Date.now()
            });
            
            console.log(`   👑 Host transferred to: ${newHostId}`);
          }
        }
        
        // Log room status
        console.log(`   📊 Room ${roomId} now has ${room.participants.size} participants`);
      }
    }
  });
  
  /**
   * Handle WebSocket errors
   */
  ws.on("error", (error) => {
    console.error(`❌ WebSocket error for user ${userId || 'unknown'}:`, error.message);
  });
});

// ==================== HEARTBEAT MONITORING ====================
// Check for dead connections every 30 seconds
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("💀 Terminating dead connection");
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ==================== SERVER STARTUP ====================
server.listen(PORT, '0.0.0.0', () => {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 LIVEKIT SIGNALING SERVER");
  console.log("=".repeat(60));
  console.log(`\n📡 Server Information:`);
  console.log(`   HTTP Server:    http://0.0.0.0:${PORT}`);
  console.log(`   WebSocket:      ws://0.0.0.0:${PORT}/ws`);
  console.log(`   Health Check:   http://0.0.0.0:${PORT}/health`);
  console.log(`   API Endpoints:  http://0.0.0.0:${PORT}/api/rooms`);
  console.log(`\n🎥 LiveKit Configuration:`);
  console.log(`   URL:            ${LIVEKIT_URL}`);
  console.log(`   API Key:        ${API_KEY.substring(0, 10)}...`);
  console.log(`   Status:         ${API_KEY && API_SECRET ? '✅ Configured' : '❌ Missing'}`);
  console.log(`\n📊 System Stats:`);
  console.log(`   Node Version:   ${process.version}`);
  console.log(`   Platform:       ${process.platform}`);
  console.log(`   Memory:         ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
  console.log(`\n✨ Server is ready to accept connections!`);
  console.log("=".repeat(60) + "\n");
});

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGTERM', () => {
  console.log('\n📡 SIGTERM signal received: closing server...');
  
  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close();
  });
  
  // Close HTTP server
  server.close(() => {
    console.log('✅ Server closed');
    clearInterval(heartbeatInterval);
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n📡 SIGINT signal received: closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    clearInterval(heartbeatInterval);
    process.exit(0);
  });
});

// Export for testing
module.exports = { wss, rooms, generateLiveKitToken };