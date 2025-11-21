// drive-server.js - PRODUCTION READY FOR RENDER
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { google } from "googleapis";
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// 🌐 Production-ready BASE_URL - works on Render and localhost
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

console.log(`🌍 Base URL: ${BASE_URL}`);

// Setup Express
const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from public folder
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Setup Socket.IO with production config
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Google Drive Setup
let drive;
try {
  const serviceAccountPath = path.join(__dirname, 'service-account-key.json');
  
  let credentials;
  if (fs.existsSync(serviceAccountPath)) {
    console.log("✅ Using service-account-key.json file");
    const keyFile = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    credentials = {
      client_email: keyFile.client_email,
      private_key: keyFile.private_key,
    };
  } else {
    console.log("✅ Using environment variables");
    credentials = {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    };
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("❌ Missing Google credentials. Check GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  drive = google.drive({ version: "v3", auth });
  console.log("🔐 Google Drive authenticated");
} catch (error) {
  console.error("❌ Failed to setup Google Drive auth:", error.message);
  process.exit(1);
}

// Store for photos
let knownPhotos = new Map();

// Function to get photos from Drive
async function getPhotosFromDrive() {
  try {
    console.log("📸 Fetching photos from Drive...");
    
    const response = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and (mimeType contains 'image/') and trashed = false`,
      fields: "files(id, name, mimeType, modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 100,
    });

    const files = response.data.files || [];
    console.log(`✅ Found ${files.length} photos`);

    // 🌐 Use BASE_URL for production-ready image URLs
    return files.map(file => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      url: `${BASE_URL}/image/${file.id}`,
    }));
  } catch (error) {
    console.error("❌ Error fetching photos:", error.message);
    return [];
  }
}

// IMAGE PROXY ROUTE - Serves images through your server
app.get("/image/:fileId", async (req, res) => {
  try {
    const fileId = req.params.fileId;
    console.log("🖼️  Serving image:", fileId);

    // Get the file from Google Drive
    const response = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    // Set proper headers
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe the image data to the response
    response.data
      .on('error', (err) => {
        console.error('Error streaming image:', err);
        res.status(500).send('Error loading image');
      })
      .pipe(res);

  } catch (error) {
    console.error("❌ Error serving image:", error.message);
    res.status(500).send('Error loading image');
  }
});

// Check for new photos
async function checkForNewPhotos() {
  try {
    const photos = await getPhotosFromDrive();
    const currentIds = new Set(photos.map(p => p.id));

    // Find new photos
    for (const photo of photos) {
      if (!knownPhotos.has(photo.id)) {
        console.log("✨ New photo detected:", photo.name);
        knownPhotos.set(photo.id, photo);
        io.emit("new-photo", photo.url);
      }
    }

    // Find removed photos
    for (const [id, photo] of knownPhotos.entries()) {
      if (!currentIds.has(id)) {
        console.log("🗑️  Photo removed:", photo.name);
        knownPhotos.delete(id);
        io.emit("photo-removed", id);
      }
    }
  } catch (error) {
    console.error("❌ Error checking photos:", error.message);
  }
}

// Routes
app.get("/", (req, res) => {
  const slideshowPath = path.join(publicDir, "slideshow.html");
  if (fs.existsSync(slideshowPath)) {
    res.sendFile(slideshowPath);
  } else {
    res.send(`
      <h1>⚠️ Setup Required</h1>
      <p>Please copy slideshow.html to the public folder:</p>
      <code>cp slideshow.html public/</code>
    `);
  }
});

app.get("/photos", async (req, res) => {
  try {
    const photos = await getPhotosFromDrive();
    res.json(photos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    photosLoaded: knownPhotos.size,
    driveFolder: DRIVE_FOLDER_ID,
    baseUrl: BASE_URL,
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// Socket.IO
io.on("connection", async (socket) => {
  console.log("🔌 Client connected:", socket.id);

  // Send all current photos
  if (knownPhotos.size === 0) {
    const photos = await getPhotosFromDrive();
    photos.forEach(p => knownPhotos.set(p.id, p));
  }

  const photoUrls = Array.from(knownPhotos.values()).map(p => p.url);
  socket.emit("all-photos", { regular: photoUrls, styled: [], merged: [] });

  socket.on("disconnect", () => {
    console.log("🔌 Client disconnected:", socket.id);
  });
});

// Start server
async function start() {
  try {
    console.log("🚀 Starting server...");
    
    if (!DRIVE_FOLDER_ID) {
      throw new Error("❌ GOOGLE_DRIVE_FOLDER_ID not set in environment");
    }
    
    const photos = await getPhotosFromDrive();
    photos.forEach(p => knownPhotos.set(p.id, p));

    // Poll every 10 seconds for new photos
    setInterval(checkForNewPhotos, 10000);

    // 🌐 Bind to 0.0.0.0 for production (required by Render)
    server.listen(PORT, '0.0.0.0', () => {
      console.log("\n" + "=".repeat(60));
      console.log(`✅ Server running at ${BASE_URL}`);
      console.log(`📸 Loaded ${knownPhotos.size} photos from Drive`);
      console.log(`🖼️  Images proxied through: ${BASE_URL}/image/[ID]`);
      console.log(`🔄 Checking for new photos every 10 seconds`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log("=".repeat(60) + "\n");
    });
  } catch (error) {
    console.error("❌ Failed to start:", error.message);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  console.log("\n👋 Shutting down...");
  server.close(() => process.exit(0));
});