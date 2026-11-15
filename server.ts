import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, type WebSocket } from 'ws';
import { JengaRoomManager, type OnlineRoom } from './server/jengaRoomPhysics.ts';
import type { ClientWsMessage, ServerWsMessage } from './shared/jengaProtocol.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const roomManager = new JengaRoomManager();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  function sendMsg(ws: WebSocket, msg: ServerWsMessage): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  wss.on('connection', (ws) => {
    let currentRoom: OnlineRoom | null = null;
    let currentPlayerId: string | null = null;

    ws.on('message', (data) => {
      let msg: ClientWsMessage;
      try {
        msg = JSON.parse(String(data)) as ClientWsMessage;
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        sendMsg(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'room:create') {
        if (currentRoom && currentPlayerId) {
          currentRoom.removePlayer(currentPlayerId, () => {
            if (currentRoom) roomManager.deleteRoom(currentRoom.roomCode);
          });
        }
        const room = roomManager.createRoom(msg.playerId, msg.playerName, ws);
        currentRoom = room;
        currentPlayerId = msg.playerId;

        sendMsg(ws, {
          type: 'room:joined',
          playerId: msg.playerId,
          room: room.getRoomState(),
          blocks: room.getBlocksSnapshot(),
        });
        return;
      }

      if (msg.type === 'room:join') {
        const target = roomManager.getRoom(msg.roomCode);
        if (!target) {
          sendMsg(ws, {
            type: 'room:error',
            message: 'ルームが見つかりません。4桁のコードを確認してください。',
          });
          return;
        }
        const ok = target.addOrReconnectPlayer(msg.playerId, msg.playerName, ws);
        if (!ok) {
          sendMsg(ws, {
            type: 'room:error',
            message:
              target.status !== 'lobby'
                ? 'このルームはすでに対戦中です。'
                : 'ルームが満員（最大4人）です。',
          });
          return;
        }
        if (currentRoom && currentRoom !== target && currentPlayerId) {
          currentRoom.removePlayer(currentPlayerId, () => {
            if (currentRoom) roomManager.deleteRoom(currentRoom.roomCode);
          });
        }
        currentRoom = target;
        currentPlayerId = msg.playerId;

        sendMsg(ws, {
          type: 'room:joined',
          playerId: msg.playerId,
          room: target.getRoomState(),
          blocks: target.getBlocksSnapshot(),
        });
        target.broadcastRoomState();
        return;
      }

      if (msg.type === 'room:leave') {
        if (currentRoom && currentPlayerId) {
          const leftRoom = currentRoom;
          const leftId = currentPlayerId;
          currentRoom = null;
          leftRoom.removePlayer(leftId, () => {
            roomManager.deleteRoom(leftRoom.roomCode);
          });
        }
        return;
      }

      if (currentRoom && currentPlayerId) {
        currentRoom.handleMessage(currentPlayerId, msg);
      }
    });

    ws.on('close', () => {
      if (currentRoom && currentPlayerId) {
        const room = currentRoom;
        room.handleDisconnect(currentPlayerId, () => {
          roomManager.deleteRoom(room.roomCode);
        });
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`KIGUMI server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
