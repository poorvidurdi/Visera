/**
 * Single Responsibility: Server Entry Point
 * 
 * Initializes Express web server, HTTP server instance, WebSocket server instance,
 * serves static frontend assets from /public, and ties together server logic modules.
 */

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const marketFeed = require('./lib/marketFeed');
const changeDetector = require('./lib/changeDetector');
const db = require('./lib/db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static assets from /public directory
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Visera server running on http://localhost:${PORT}`);
  });
}

module.exports = { app, server, wss };
