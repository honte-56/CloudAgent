import express from 'express';
import { WebSocketServer } from 'ws';
import type { VerifyClientCallbackSync } from 'ws';

import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

import { authenticateToken, authenticateWebSocket, generateToken } from '../../auth.middleware.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';

// The parent supplies a temporary DATABASE_PATH and NODE_ENV=test before any
// imports execute, so this fixture can never migrate a developer's auth data.
await initializeDatabase();
const user = userDb.createUser('fixture', 'unused-password-hash');
const token = generateToken(user);
const app = express();
app.get('/protected', authenticateToken, (_request, response) => { response.json({ authenticated: true }); });
const server = app.listen(0, '127.0.0.1');
const wss = new WebSocketServer({
  server,
  verifyClient: (info: Parameters<VerifyClientCallbackSync>[0]) => verifyWebSocketClient(info, { authenticateWebSocket }),
});
// Authenticated test sockets never invoke terminal or provider handlers.
wss.on('connection', (socket) => { socket.send('authenticated'); });
server.on('listening', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ port: address.port, token });
});
process.on('SIGTERM', () => {
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  server.closeAllConnections();
  server.close(() => { closeConnection(); process.exit(0); });
});
