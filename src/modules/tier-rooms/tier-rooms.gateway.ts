import {
  WebSocketGateway, WebSocketServer,
  SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
  ConnectedSocket, MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket }       from 'socket.io';
import { Injectable, Logger }   from '@nestjs/common';
import { JwtService }           from '@nestjs/jwt';
import { ConfigService }        from '@nestjs/config';
import { InjectDataSource }     from '@nestjs/typeorm';
import { DataSource }           from 'typeorm';
import { CACHE_MANAGER }        from '@nestjs/cache-manager';
import { Cache }                from 'cache-manager';
import { Inject }               from '@nestjs/common';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/tier-rooms/tier-rooms.gateway.ts
//
// WebSocket gateway for real-time features:
//
//   EVENTS EMITTED TO CLIENT:
//     tier:presence_update  — live member count per tier changes
//     tier:promotion        — user was promoted (targeted to that user)
//     tier:demotion         — user was demoted (targeted to that user)
//     room:leaderboard_tick — top-3 leaderboard update every 30 min
//     session:afk_warning   — server detected AFK during heartbeat
//
//   EVENTS RECEIVED FROM CLIENT:
//     session:heartbeat     — client heartbeat (replaces REST heartbeat)
//     tier:join_room        — user joined a tier room view
//     tier:leave_room       — user left a tier room view
//
// Auth: JWT token sent in handshake.auth.token
// Redis: used for presence tracking (SADD/SCARD on join/leave)
// ════════════════════════════════════════════════════════════

@WebSocketGateway({
  namespace: '/tier-rooms',
  cors: {
    origin: ['http://localhost:3000', 'https://admin.bpscnotes.in'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
@Injectable()
export class TierRoomsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(TierRoomsGateway.name);

  // In-memory presence: tierKey -> Set<userId>
  // For production scale, move to Redis SADD/SCARD
  private readonly presence = new Map<string, Set<string>>();

  // userId -> socketId (one active WS connection per user)
  private readonly userSockets = new Map<string, string>();

  // socketId -> userId (reverse lookup on disconnect)
  private readonly socketUsers = new Map<string, string>();

  // socketId -> tierKey (what tier room is this socket viewing)
  private readonly socketTier  = new Map<string, string>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly config:     ConfigService,
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  afterInit(server: Server) {
    this.logger.log('TierRoomsGateway initialised');
  }

  // ── On connect: authenticate via JWT token ────────────────
  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      if (!token) throw new WsException('No auth token');

      const payload = this.jwtService.verify(token, {
        secret: this.config.get<string>('jwt.secret'),
      }) as { userId: string };

      if (!payload?.userId) throw new WsException('Invalid token');

      // Attach userId to socket
      (client as any).userId = payload.userId;

      // If user already has a socket, disconnect old one
      const prevSocketId = this.userSockets.get(payload.userId);
      if (prevSocketId && prevSocketId !== client.id) {
        const prevSocket = this.server.sockets.sockets.get(prevSocketId);
        prevSocket?.disconnect();
      }

      this.userSockets.set(payload.userId, client.id);
      this.socketUsers.set(client.id, payload.userId);

      this.logger.log(`WS connected: user=${payload.userId} socket=${client.id}`);

      // Send current presence snapshot to new connection
      const snapshot = this.buildPresenceSnapshot();
      client.emit('presence:snapshot', snapshot);

    } catch (err: any) {
      this.logger.warn(`WS auth failed: ${err.message}`);
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect();
    }
  }

  // ── On disconnect: clean up presence ─────────────────────
  handleDisconnect(client: Socket) {
    const userId  = this.socketUsers.get(client.id);
    const tierKey = this.socketTier.get(client.id);

    if (userId) {
      this.userSockets.delete(userId);
      this.socketUsers.delete(client.id);

      if (tierKey) {
        this.presence.get(tierKey)?.delete(userId);
        this.socketTier.delete(client.id);
        this.broadcastPresenceUpdate(tierKey);
      }
    }
    this.logger.log(`WS disconnected: socket=${client.id}`);
  }

  // ── CLIENT: joins a tier room view ────────────────────────
  // Client sends this when they open RoomsHubScreen or TierRoomScreen
  @SubscribeMessage('tier:join_room')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tierKey: string },
  ) {
    const userId   = (client as any).userId as string;
    const tierKey  = data?.tierKey;
    if (!userId || !tierKey) return;

    // Leave previous tier room if any
    const prevTier = this.socketTier.get(client.id);
    if (prevTier && prevTier !== tierKey) {
      this.presence.get(prevTier)?.delete(userId);
      client.leave(`tier:${prevTier}`);
      this.broadcastPresenceUpdate(prevTier);
    }

    // Join new tier room socket.io room
    client.join(`tier:${tierKey}`);
    this.socketTier.set(client.id, tierKey);

    if (!this.presence.has(tierKey)) this.presence.set(tierKey, new Set());
    this.presence.get(tierKey)!.add(userId);

    this.broadcastPresenceUpdate(tierKey);

    // Acknowledge
    return { event: 'tier:joined', tierKey, activeNow: this.presence.get(tierKey)!.size };
  }

  // ── CLIENT: leaves tier room view ─────────────────────────
  @SubscribeMessage('tier:leave_room')
  handleLeaveRoom(@ConnectedSocket() client: Socket) {
    const userId  = (client as any).userId as string;
    const tierKey = this.socketTier.get(client.id);
    if (!userId || !tierKey) return;

    this.presence.get(tierKey)?.delete(userId);
    client.leave(`tier:${tierKey}`);
    this.socketTier.delete(client.id);
    this.broadcastPresenceUpdate(tierKey);
    return { event: 'tier:left' };
  }

  // ── CLIENT: send chat message ────────────────────────────────
  @SubscribeMessage('room:send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { message: string },
  ) {
    const userId  = (client as any).userId as string;
    const tierKey = this.socketTier.get(client.id);
    if (!userId || !tierKey) throw new WsException('Not in a room.');

    const msg = data?.message?.trim();
    if (!msg) return;
    if (msg.length > 500) throw new WsException('Max 500 characters.');

    // Rate limit: 1 msg/sec per user (in-memory)
    const last = this.lastMsgTime.get(userId) ?? 0;
    if (Date.now() - last < 1000) throw new WsException('Too fast. Slow down.');
    this.lastMsgTime.set(userId, Date.now());

    // Persist to DB
    const saved = await this.db.query(`
      INSERT INTO room_messages (tier_key, sender_id, sender_name, message)
      SELECT $1, $2, u.name, $3 FROM users u WHERE u.id=$2
      RETURNING id, sender_name, message, created_at
    `, [tierKey, userId, msg]);
    if (!saved.length) return;

    const row = saved[0];
    // Broadcast to everyone in this tier room (including sender for confirmation)
    this.server.to(`tier:${tierKey}`).emit('room:new_message', {
      id:         row.id,
      senderId:   userId,
      senderName: row.sender_name,
      message:    row.message,
      tierKey,
      createdAt:  row.created_at,
    });
  }

  private readonly lastMsgTime = new Map<string, number>();

  // ── SERVER: get chat history (called from REST controller) ───
  async getChatHistory(tierKey: string, limit = 50): Promise<any[]> {
    return this.db.query(`
      SELECT id, sender_id AS "senderId", sender_name AS "senderName",
             message, tier_key AS "tierKey", created_at AS "createdAt"
      FROM room_messages
      WHERE tier_key = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [tierKey, limit]);
  }

  // ── CLIENT: WebSocket heartbeat ───────────────────────────
  // Replaces REST POST /rooms/sessions/heartbeat for WS-connected clients.
  // Falls back to REST for clients that don't have WS (e.g. background app).
  @SubscribeMessage('session:heartbeat')
  async handleHeartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId: string },
  ) {
    const userId = (client as any).userId as string;
    if (!userId || !data?.sessionId) {
      throw new WsException('userId and sessionId required');
    }

    const sessions = await this.db.query(`
      SELECT ss.id, ss.tier_id, ss.active_minutes, ss.coins_earned,
             ss.xp_earned, ss.afk_count, ss.last_heartbeat,
             t.coin_multiplier, t.xp_multiplier
      FROM study_sessions ss
      LEFT JOIN room_tiers t ON t.id = ss.tier_id
      WHERE ss.id=$1 AND ss.user_id=$2 AND ss.ended_at IS NULL
    `, [data.sessionId, userId]);

    if (!sessions.length) {
      throw new WsException('Session not found or already ended');
    }

    const s      = sessions[0];
    const gapSec = (Date.now() - new Date(s.last_heartbeat).getTime()) / 1000;
    const isAfk  = gapSec > 420;   // 7 min threshold

    let coinsThisBeat = 0, xpThisBeat = 0, activeMins = 0;

    if (!isAfk) {
      activeMins    = Math.min(gapSec / 60, 5);
      const coinMul = parseFloat(s.coin_multiplier || '1');
      const xpMul   = parseFloat(s.xp_multiplier   || '1');
      coinsThisBeat = Math.floor((activeMins / 60) * 6 * coinMul);
      xpThisBeat    = Math.floor(activeMins * 1 * xpMul);

      if (coinsThisBeat > 0) {
        // Check daily cap
        const capped = await this.checkDailyCap(userId);
        if (!capped) {
          await this.db.query(
            `UPDATE users SET coins=coins+$1, total_coins_earned=total_coins_earned+$1 WHERE id=$2`,
            [coinsThisBeat, userId]
          );
          const bal = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
          await this.db.query(
            `INSERT INTO coin_transactions (user_id,type,amount,description,action,ref_id,balance)
             VALUES ($1,'earned',$2,'Study time (WS)','study_time',$3,$4)`,
            [userId, coinsThisBeat, data.sessionId, bal[0].coins]
          );
        } else {
          coinsThisBeat = 0;
        }
      }

      if (xpThisBeat > 0) {
        await this.db.query(`UPDATE users SET xp=xp+$1 WHERE id=$2`, [xpThisBeat, userId]);
      }

      const roundMins = Math.round(activeMins);
      await this.db.query(`
        UPDATE study_sessions
        SET active_minutes=active_minutes+$1, coins_earned=coins_earned+$2,
            xp_earned=xp_earned+$3, last_heartbeat=NOW()
        WHERE id=$4
      `, [roundMins, coinsThisBeat, xpThisBeat, data.sessionId]);

      if (roundMins > 0) {
        await this.db.query(
          `UPDATE users SET total_study_minutes=total_study_minutes+$1 WHERE id=$2`,
          [roundMins, userId]
        );
      }
      await this.cache.del(`user_tier:${userId}`);
    } else {
      await this.db.query(
        `UPDATE study_sessions SET afk_count=afk_count+1, last_heartbeat=NOW() WHERE id=$1`,
        [data.sessionId]
      );
      // Emit AFK warning directly to this socket (private)
      client.emit('session:afk_warning', { sessionId: data.sessionId, gapSeconds: Math.round(gapSec) });
    }

    // Return result to this socket
    return {
      event:              'session:heartbeat_ack',
      isAfk,
      activeMinsThisBeat: Math.round(activeMins),
      coinsEarnedThisBeat: coinsThisBeat,
      xpEarnedThisBeat:    xpThisBeat,
      totalCoinsThisSession: s.coins_earned + coinsThisBeat,
      totalXpThisSession:    s.xp_earned    + xpThisBeat,
      totalActiveMinutes:    s.active_minutes + Math.round(activeMins),
    };
  }

  // ── SERVER: emit promotion event to a specific user ───────
  // Called by TierRoomsCronService after promoteUser()
  emitPromotion(userId: string, tierKey: string, tierName: string, tierEmoji: string) {
    const socketId = this.userSockets.get(userId);
    if (!socketId) return false;  // user offline — push notification handles it instead

    this.server.to(socketId).emit('tier:promotion', {
      tierKey, tierName, tierEmoji,
      message: `You've been promoted to ${tierEmoji} ${tierName}!`,
    });
    this.logger.log(`WS promotion emitted: user=${userId} tier=${tierKey}`);
    return true;
  }

  // ── SERVER: emit demotion event to a specific user ────────
  emitDemotion(userId: string, tierKey: string, tierName: string, tierEmoji: string) {
    const socketId = this.userSockets.get(userId);
    if (!socketId) return false;

    this.server.to(socketId).emit('tier:demotion', {
      tierKey, tierName, tierEmoji,
      message: `You've been moved to ${tierEmoji} ${tierName}. Keep studying to come back!`,
    });
    return true;
  }

  // ── SERVER: broadcast leaderboard update to a tier room ───
  // Called by cron every 30 min during active hours
  broadcastLeaderboardTick(tierKey: string, top3: any[]) {
    this.server.to(`tier:${tierKey}`).emit('room:leaderboard_tick', {
      tierKey, top3, updatedAt: new Date().toISOString(),
    });
  }

  // ── SERVER: broadcast presence (member count) ─────────────
  private broadcastPresenceUpdate(tierKey: string) {
    const count = this.presence.get(tierKey)?.size ?? 0;
    this.server.to(`tier:${tierKey}`).emit('tier:presence_update', {
      tierKey, activeNow: count,
    });
    // Also emit to ALL connected clients (for the lobby screen)
    this.server.emit('tier:presence_update', { tierKey, activeNow: count });
  }

  private buildPresenceSnapshot(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    this.presence.forEach((users, tierKey) => { snapshot[tierKey] = users.size; });
    return snapshot;
  }

  private async checkDailyCap(userId: string): Promise<boolean> {
    const rule = await this.db.query(
      `SELECT max_per_day FROM coin_rules WHERE action='study_time' AND is_active=TRUE LIMIT 1`
    );
    if (!rule.length) return false;
    const today = await this.db.query(
      `SELECT COALESCE(SUM(amount),0)::int AS total FROM coin_transactions
       WHERE user_id=$1 AND action='study_time' AND created_at::date=CURRENT_DATE`,
      [userId]
    );
    return +today[0].total >= +rule[0].max_per_day;
  }

  private extractToken(client: Socket): string | null {
    return (
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization?.replace('Bearer ', '') ||
      null
    );
  }

  // ── Cron: every 30 min during study hours — leaderboard tick
  // Called by TierRoomsCronService, NOT a @Cron here
  // (cron lives in the service, gateway just handles emit)
  async getOnlineCount(tierKey: string): Promise<number> {
    return this.presence.get(tierKey)?.size ?? 0;
  }

  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId);
  }
}
