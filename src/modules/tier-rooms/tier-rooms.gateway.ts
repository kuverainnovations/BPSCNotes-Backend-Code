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
//
//   EVENTS RECEIVED FROM CLIENT:
//     tier:join_room        — user joined a tier room view
//     tier:leave_room       — user left a tier room view
//
// Auth: JWT token sent in handshake.auth.token
//
// Presence: "active now" counts come from study_sessions in Postgres
// (shared across instances), not in-process memory — see
// getActiveSessionCount(). Concurrent calls for the same tier within the
// same DB round-trip share one in-flight query instead of each firing
// their own, which is what actually matters for scale here (the count
// itself is always correct and fresh — there's no cached/stale value to
// reason about, just deduplicated concurrent reads).
//
// userSockets/socketUsers/socketTier below ARE in-process and assume a
// single backend instance — fine for the current single-VPS deployment.
// If this ever runs multiple instances behind a load balancer, targeted
// per-user delivery (emitPromotion/emitDemotion, the single-socket-per-
// user enforcement in handleConnection) needs either sticky sessions at
// the load balancer or the Socket.IO Redis adapter; the presence COUNT
// itself would keep working correctly either way since it's DB-backed.
//
// REST is the only heartbeat path (StudySessionsService.heartbeat, via
// POST /rooms/sessions/heartbeat) — there used to be a parallel WS
// session:heartbeat handler here too, but the app never actually called
// it (TierRoomsSocketManager.sendHeartbeat() on Android was dead code),
// and it had drifted out of sync with the real anti-cheat logic — it
// never called AntiCheatService at all, so if anything had ever started
// using it, it would have silently skipped every anti-cheat check.
// Removed rather than fixed in place, since a second, divergent
// heartbeat implementation living dormant is itself a future bug.
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
  @WebSocketServer() server!: Server;   // public — used by StudySessionsService for member events

  private readonly logger = new Logger(TierRoomsGateway.name);

  // userId -> socketId (one active WS connection per user)
  private readonly userSockets = new Map<string, string>();

  // tierKey -> in-flight active-session-count query, so a burst of joins/
  // leaves/disconnects for the same room within one DB round-trip share a
  // single query instead of each firing its own. Cleared as soon as that
  // query resolves, so the next call always gets a fresh read — this is
  // request deduplication, not caching, so there's no staleness to reason
  // about. See getActiveSessionCount().
  private readonly inFlightCounts = new Map<string, Promise<number>>();

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

      // Send current presence snapshot to new connection — same DB-backed
      // active-session count as the tier:presence_update events that
      // follow, so the number doesn't jump right after connecting.
      const snapshot = await this.buildPresenceSnapshot();
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
        this.socketTier.delete(client.id);
        this.broadcastPresenceUpdate(tierKey);
      }
    }
    this.logger.log(`WS disconnected: socket=${client.id}`);
  }

  // ── CLIENT: joins a tier room view ────────────────────────
  // Client sends this when they open RoomsHubScreen or TierRoomScreen
  @SubscribeMessage('tier:join_room')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tierKey: string },
  ) {
    const userId   = (client as any).userId as string;
    const tierKey  = data?.tierKey;
    if (!userId || !tierKey) return;

    // Leave previous tier room if any
    const prevTier = this.socketTier.get(client.id);
    if (prevTier && prevTier !== tierKey) {
      client.leave(`tier:${prevTier}`);
      this.broadcastPresenceUpdate(prevTier);
    }

    // Join new tier room socket.io room
    client.join(`tier:${tierKey}`);
    this.socketTier.set(client.id, tierKey);

    // FIX: Presence count = active study SESSIONS, not socket connections.
    // A user viewing the lobby gets added to socketTier (for chat routing)
    // but the broadcast count comes from DB active sessions, not socket set.
    // This stops the "1 online" bug when user just opens the page.
    const activeCount = await this.getActiveSessionCount(tierKey);
    this.broadcastPresenceUpdate(tierKey);

    // Acknowledge
    return { event: 'tier:joined', tierKey, activeNow: activeCount };
  }

  // ── CLIENT: leaves tier room view ─────────────────────────
  @SubscribeMessage('tier:leave_room')
  handleLeaveRoom(@ConnectedSocket() client: Socket) {
    const userId  = (client as any).userId as string;
    const tierKey = this.socketTier.get(client.id);
    if (!userId || !tierKey) return;

    client.leave(`tier:${tierKey}`);
    this.socketTier.delete(client.id);
    this.broadcastPresenceUpdate(tierKey);
    return { event: 'tier:left' };
  }

  // ── CLIENT: send chat message ────────────────────────────────
  @SubscribeMessage('room:send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { message: string; tierKey?: string },
  ) {
    const userId = (client as any).userId as string;
    // FIX: Use tierKey from socketTier map (set by join_room) OR from payload fallback.
    // Without payload fallback, a race condition causes "Not in a room" if
    // the client sends a message immediately after a reconnect before join_room completes.
    const tierKey = this.socketTier.get(client.id) || data?.tierKey;
    if (!userId || !tierKey) throw new WsException('Not in a room.');
    // Also register in socketTier if it was resolved from payload
    if (!this.socketTier.has(client.id) && data?.tierKey) {
      client.join(`tier:${tierKey}`);
      this.socketTier.set(client.id, tierKey);
    }

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

  // ── SERVER: record + broadcast a room activity feed event ─
  // Used by StudySessionsService (session joined, streak milestones) and
  // TierRoomsCronService (promotions/demotions). Lives here rather than as
  // a separate service because every caller already injects this gateway
  // for broadcastPresenceUpdate/emitPromotion, so this avoids adding a new
  // shared dependency (and the DI wiring risk that comes with it) for what
  // is, same as room chat above, a small DB write + room broadcast.
  async recordActivityFeedEvent(
    roomTierId: string,
    tierKey: string,
    userId: string | null,
    userName: string,
    eventType: 'joined' | 'left' | 'streak_milestone' | 'promoted' | 'demoted'
      | 'session_completed' | 'champion',
    metadata: Record<string, any> = {},
  ) {
    try {
      const [row] = await this.db.query(`
        INSERT INTO room_activity_feed (room_tier_id, user_id, user_name, event_type, metadata)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at
      `, [roomTierId, userId, userName, eventType, JSON.stringify(metadata)]);

      // Keep each room's feed bounded — application-side trim (not a DB
      // trigger; this codebase doesn't use those anywhere) right after
      // insert. Cheap: only does real work once a room crosses 200 rows.
      await this.db.query(`
        DELETE FROM room_activity_feed
        WHERE room_tier_id = $1 AND id NOT IN (
          SELECT id FROM room_activity_feed WHERE room_tier_id = $1
          ORDER BY created_at DESC LIMIT 200
        )
      `, [roomTierId]);

      this.server.to(`tier:${tierKey}`).emit('room:activity', {
        id: row.id, tierKey, userId, userName, eventType, metadata,
        createdAt: row.created_at,
      });
    } catch (e: any) {
      // Activity feed is supplementary — never let a feed write failure
      // break the session/promotion flow that triggered it.
      this.logger.error(`Activity feed write failed: ${e.message}`);
    }
  }

  // ── SERVER: broadcast presence (member count) ─────────────
  private async getActiveSessionCount(tierKey: string): Promise<number> {
    // Piggyback on an in-flight query for the same tier instead of firing
    // a duplicate — a burst of joins/leaves/disconnects in the same room
    // (e.g. a network blip dropping many users at once) would otherwise
    // fire one identical COUNT query per affected socket.
    const existing = this.inFlightCounts.get(tierKey);
    if (existing) return existing;

    const promise = (async () => {
      try {
        // FIX: was joining through user_room_tier.current_tier_id — a user's
        // permanent/home tier, NOT the room they're actually sitting in. A
        // session can be in a different room than the user's home tier (the
        // app explicitly supports studying in a lower, already-unlocked
        // room — see StudySessionsService.startSession's room_tier_id), so
        // this undercounted the room actually being visited and overcounted
        // the user's home room. Count by the session's own room directly,
        // same pattern getTierMembers() already uses correctly.
        const [row] = await this.db.query(
          `SELECT COUNT(DISTINCT ss.user_id)::int AS active
           FROM study_sessions ss
           WHERE COALESCE(ss.room_tier_id, ss.tier_id) = (SELECT id FROM room_tiers WHERE tier_key = $1)
             AND ss.ended_at IS NULL`,
          [tierKey]
        );
        return row?.active ?? 0;
      } catch { return 0; }
    })();

    this.inFlightCounts.set(tierKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlightCounts.delete(tierKey);
    }
  }

  broadcastPresenceUpdate(tierKey: string) {  // public — called from StudySessionsService
    // FIX: Use DB session count not socket connection count.
    // Viewing the lobby emits tier:join_room which adds to socket presence,
    // but should NOT increment "studying" count until a session is started.
    this.getActiveSessionCount(tierKey).then(activeNow => {
      this.server.to(`tier:${tierKey}`).emit('tier:presence_update', { tierKey, activeNow });
      this.server.emit('tier:presence_update', { tierKey, activeNow });
    });
  }

  // FIX: was built from the in-memory socket-presence Map — a different,
  // less accurate concept ("sockets currently viewing this tier") than the
  // DB-backed active-session count that every subsequent tier:presence_update
  // actually uses. A freshly-connected client would see one number here and
  // then have it jump as soon as any presence_update arrived. Now both use
  // the same source of truth. room_tiers is a tiny table — fine to compute
  // every active tier's count on every connect.
  private async buildPresenceSnapshot(): Promise<Record<string, number>> {
    const tiers = await this.db.query(`SELECT tier_key FROM room_tiers WHERE is_active = TRUE`);
    const counts = await Promise.all(
      tiers.map((t: any) => this.getActiveSessionCount(t.tier_key))
    );
    const snapshot: Record<string, number> = {};
    tiers.forEach((t: any, i: number) => { snapshot[t.tier_key] = counts[i]; });
    return snapshot;
  }

  private extractToken(client: Socket): string | null {
    return (
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization?.replace('Bearer ', '') ||
      null
    );
  }

  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId);
  }
}