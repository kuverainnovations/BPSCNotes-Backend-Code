import {
    Module, Injectable, Controller,
    Get, Post, Patch,
    Body, Param, Query, Req,
    UseGuards, HttpCode, HttpStatus,
    ParseUUIDPipe, BadRequestException, ForbiddenException,
    NotFoundException, Logger,
  } from '@nestjs/common';
  import {
    WebSocketGateway, WebSocketServer,
    SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
    ConnectedSocket, MessageBody, WsException,
  } from '@nestjs/websockets';
  import { Server, Socket } from 'socket.io';
  import { JwtService, JwtModule } from '@nestjs/jwt';
  import { ConfigService, ConfigModule } from '@nestjs/config';
  import { InjectDataSource } from '@nestjs/typeorm';
  import { DataSource } from 'typeorm';
  import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
  import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
  import { successResponse, paginationMeta } from '../../common/utils/response.util';
  import { AuthModule } from '../auth/auth.module';
  import * as admin from 'firebase-admin';
  import { ensureFirebaseAdmin } from '../../common/firebase/firebase-admin';
  
  // ════════════════════════════════════════════════════════════
  // MATERIAL CHAT — buyer <-> uploader chat scoped to one material,
  // only available after purchase. Plus "Report / Escalate to
  // Support" for refunds, disputes, content issues, and seller
  // misconduct (NOT academic doubts — the uploader handles those).
  // ════════════════════════════════════════════════════════════
  
  const ESCALATION_CATEGORIES = ['refund', 'dispute', 'content', 'seller_misconduct', 'other'] as const;
  type EscalationCategory = typeof ESCALATION_CATEGORIES[number];
  
  // ─────────────────────────────────────────────────────────────
  // SERVICE
  // ─────────────────────────────────────────────────────────────
  @Injectable()
  export class MaterialChatService {
    private readonly logger = new Logger(MaterialChatService.name);
  
    constructor(@InjectDataSource() private readonly db: DataSource) {}
  
    // ── Access control: is this user the buyer or uploader for this material? ──
    // Returns the chat row's role context, creating the thread on first access
    // (lazily — only buyers who purchased, or the uploader once a buyer has
    // started a thread, can reach this point).
    private async resolveChatAccess(materialId: string, userId: string) {
      const [material] = await this.db.query(
        `SELECT id, title, uploader_id FROM study_materials WHERE id=$1`,
        [materialId]
      );
      if (!material) throw new NotFoundException('Material not found');
  
      const isUploader = material.uploader_id === userId;
  
      if (isUploader) {
        // Uploader can only access threads that already exist (a buyer
        // must have purchased AND opened the chat first to create the thread).
        return { material, isUploader: true, isBuyer: false };
      }
  
      // Buyer path — must have purchased
      const [purchase] = await this.db.query(
        `SELECT id FROM material_purchases WHERE material_id=$1 AND user_id=$2`,
        [materialId, userId]
      );
      if (!purchase) {
        throw new ForbiddenException('Chat is only available after purchasing this material.');
      }
      return { material, isUploader: false, isBuyer: true };
    }
  
    // ── Get or create the buyer's chat thread for a material ───
    // Called by the buyer when opening "Chat with uploader".
    async getOrCreateThread(materialId: string, userId: string) {
      const { material, isBuyer } = await this.resolveChatAccess(materialId, userId);
      if (!isBuyer) {
        throw new ForbiddenException('Only buyers can start a chat thread.');
      }
      if (!material.uploader_id) {
        throw new BadRequestException('This material has no uploader to chat with.');
      }
      if (material.uploader_id === userId) {
        throw new BadRequestException('You cannot chat with yourself about your own upload.');
      }
  
      const [existing] = await this.db.query(
        `SELECT * FROM material_chats WHERE material_id=$1 AND buyer_id=$2`,
        [materialId, userId]
      );
      if (existing) return existing;
  
      const [created] = await this.db.query(
        `INSERT INTO material_chats (material_id, buyer_id, uploader_id)
         VALUES ($1,$2,$3) RETURNING *`,
        [materialId, userId, material.uploader_id]
      );
      return created;
    }
  
    // ── List all chat threads for the current user ─────────────
    // Buyers see threads they started; uploaders see threads buyers
    // started with them. Used for a "My Chats" inbox.
    async listThreads(userId: string) {
      const rows = await this.db.query(
        `SELECT mc.*, sm.title AS material_title,
                CASE WHEN mc.buyer_id=$1 THEN u_up.name ELSE u_buy.name END AS other_party_name,
                CASE WHEN mc.buyer_id=$1 THEN 'uploader' ELSE 'buyer' END AS role,
                (SELECT message FROM material_chat_messages mcm WHERE mcm.chat_id=mc.id ORDER BY created_at DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM material_chat_messages mcm WHERE mcm.chat_id=mc.id AND mcm.sender_id!=$1 AND mcm.is_read=FALSE) AS unread_count
         FROM material_chats mc
         JOIN study_materials sm ON sm.id = mc.material_id
         JOIN users u_buy ON u_buy.id = mc.buyer_id
         JOIN users u_up  ON u_up.id  = mc.uploader_id
         WHERE mc.buyer_id=$1 OR mc.uploader_id=$1
         ORDER BY COALESCE(mc.last_message_at, mc.created_at) DESC`,
        [userId]
      );
      return successResponse({
        threads: rows.map((r: any) => ({ ...r, unread_count: parseInt(r.unread_count ?? '0', 10) })),
      });
    }
  
    // ── Get a chat thread by ID + message history ───────────────
    async getThread(chatId: string, userId: string, page = 1, limit = 50) {
      const [chat] = await this.db.query(
        `SELECT mc.*, sm.title AS material_title,
                CASE WHEN mc.buyer_id=$2 THEN u_up.name ELSE u_buy.name END AS other_party_name
         FROM material_chats mc
         JOIN study_materials sm ON sm.id = mc.material_id
         JOIN users u_buy ON u_buy.id = mc.buyer_id
         JOIN users u_up  ON u_up.id  = mc.uploader_id
         WHERE mc.id=$1`,
        [chatId, userId]
      );
      if (!chat) throw new NotFoundException('Chat not found');
      if (chat.buyer_id !== userId && chat.uploader_id !== userId) {
        throw new ForbiddenException('Not part of this conversation');
      }
  
      const offset = (page - 1) * limit;
      const messages = await this.db.query(
        `SELECT id, sender_id, message, is_read, created_at
         FROM material_chat_messages WHERE chat_id=$1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [chatId, limit, offset]
      );
  
      // Mark messages from the other party as read
      await this.db.query(
        `UPDATE material_chat_messages SET is_read=TRUE
         WHERE chat_id=$1 AND sender_id!=$2 AND is_read=FALSE`,
        [chatId, userId]
      );
  
      return successResponse({
        chat,
        messages: messages.reverse(), // oldest first for display
      });
    }
  
    // ── Send a message (REST fallback; WS gateway is primary path) ──
    async sendMessage(chatId: string, userId: string, message: string) {
      const trimmed = message?.trim();
      if (!trimmed) throw new BadRequestException('Message cannot be empty');
      if (trimmed.length > 1000) throw new BadRequestException('Message too long (max 1000 characters)');
  
      const [chat] = await this.db.query(`SELECT * FROM material_chats WHERE id=$1`, [chatId]);
      if (!chat) throw new NotFoundException('Chat not found');
      if (chat.buyer_id !== userId && chat.uploader_id !== userId) {
        throw new ForbiddenException('Not part of this conversation');
      }
      if (chat.status === 'closed') {
        throw new BadRequestException('This chat has been closed.');
      }
  
      const [saved] = await this.db.query(
        `INSERT INTO material_chat_messages (chat_id, sender_id, message)
         VALUES ($1,$2,$3) RETURNING id, sender_id, message, is_read, created_at`,
        [chatId, userId, trimmed]
      );
      await this.db.query(
        `UPDATE material_chats SET last_message_at=NOW() WHERE id=$1`,
        [chatId]
      );
  
      // Push notification to the other party
      const recipientId = chat.buyer_id === userId ? chat.uploader_id : chat.buyer_id;
      this.pushChatNotification(recipientId, chatId, trimmed).catch(() => {});
  
      return successResponse(saved);
    }
  
    private async pushChatNotification(recipientId: string, chatId: string, message: string) {
      try {
        const [user] = await this.db.query(`SELECT fcm_token, name FROM users WHERE id=$1`, [recipientId]);
        if (!user?.fcm_token) return;
        ensureFirebaseAdmin();
        await admin.messaging().send({
          token: user.fcm_token,
          notification: {
            title: '💬 New message',
            body: message.length > 80 ? message.slice(0, 80) + '…' : message,
          },
          data: { type: 'material_chat_message', chatId, screen: 'study_materials' },
          android: { priority: 'high' },
        });
      } catch (err: any) {
        this.logger.warn(`pushChatNotification failed: ${err.message}`);
      }
    }
  
    // ── Escalate a chat to support ───────────────────────────────
    async escalate(chatId: string, userId: string, category: EscalationCategory, reason: string) {
      if (!reason?.trim()) throw new BadRequestException('Please describe the issue');
      if (!ESCALATION_CATEGORIES.includes(category)) category = 'other';
  
      const [chat] = await this.db.query(`SELECT * FROM material_chats WHERE id=$1`, [chatId]);
      if (!chat) throw new NotFoundException('Chat not found');
      if (chat.buyer_id !== userId && chat.uploader_id !== userId) {
        throw new ForbiddenException('Not part of this conversation');
      }
  
      // Prevent duplicate open escalations on the same chat
      const [existing] = await this.db.query(
        `SELECT id FROM support_escalations WHERE chat_id=$1 AND status != 'resolved'`,
        [chatId]
      );
      if (existing) {
        return successResponse({ escalationId: existing.id, alreadyOpen: true }, 'This chat already has an open support ticket.');
      }
  
      const [escalation] = await this.db.query(
        `INSERT INTO support_escalations (chat_id, material_id, buyer_id, uploader_id, category, reason)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [chatId, chat.material_id, chat.buyer_id, chat.uploader_id, category, reason.trim()]
      );
  
      await this.db.query(`UPDATE material_chats SET status='escalated' WHERE id=$1`, [chatId]);
  
      return successResponse({ escalationId: escalation.id }, '🚩 Escalated to support — our team will review this conversation.');
    }
  
    // ── ADMIN: list support escalations ──────────────────────────
    async adminListEscalations(query: any) {
      const page   = Math.max(1, +(query.page  ?? 1));
      const limit  = Math.min(100, +(query.limit ?? 20));
      const offset = (page - 1) * limit;
  
      const conditions: string[] = ['1=1'];
      const params: any[] = [];
      let pi = 1;
      if (query.status)   { conditions.push(`se.status=$${pi++}`);   params.push(query.status); }
      if (query.category) { conditions.push(`se.category=$${pi++}`); params.push(query.category); }
      const where = conditions.join(' AND ');
  
      const [rows, [cnt]] = await Promise.all([
        this.db.query(
          `SELECT se.*, sm.title AS material_title,
                  u_buy.name AS buyer_name, u_buy.mobile AS buyer_mobile,
                  u_up.name AS uploader_name
           FROM support_escalations se
           JOIN study_materials sm ON sm.id = se.material_id
           JOIN users u_buy ON u_buy.id = se.buyer_id
           JOIN users u_up  ON u_up.id  = se.uploader_id
           WHERE ${where}
           ORDER BY se.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
          [...params, limit, offset]
        ),
        this.db.query(`SELECT COUNT(*) FROM support_escalations se WHERE ${where}`, params),
      ]);
  
      return successResponse({
        escalations: rows,
        meta: paginationMeta(parseInt(cnt.count, 10), page, limit),
      });
    }
  
    // ── ADMIN: view full chat transcript for an escalation ────────
    async adminGetEscalationChat(escalationId: string) {
      const [escalation] = await this.db.query(
        `SELECT se.*, sm.title AS material_title,
                u_buy.name AS buyer_name, u_up.name AS uploader_name
         FROM support_escalations se
         JOIN study_materials sm ON sm.id = se.material_id
         JOIN users u_buy ON u_buy.id = se.buyer_id
         JOIN users u_up  ON u_up.id  = se.uploader_id
         WHERE se.id=$1`,
        [escalationId]
      );
      if (!escalation) throw new NotFoundException('Escalation not found');
  
      const messages = await this.db.query(
        `SELECT mcm.id, mcm.sender_id, mcm.message, mcm.created_at,
                CASE WHEN mcm.sender_id=se.buyer_id THEN 'buyer' ELSE 'uploader' END AS sender_role
         FROM material_chat_messages mcm
         JOIN support_escalations se ON se.chat_id = mcm.chat_id
         WHERE se.id=$1
         ORDER BY mcm.created_at ASC`,
        [escalationId]
      );
  
      return successResponse({ escalation, messages });
    }
  
    // ── ADMIN: update escalation status ───────────────────────────
    async adminUpdateEscalation(escalationId: string, status: 'open' | 'in_progress' | 'resolved', resolutionNote?: string) {
      if (!['open', 'in_progress', 'resolved'].includes(status)) {
        throw new BadRequestException('Invalid status');
      }
      await this.db.query(
        `UPDATE support_escalations
         SET status=$2, resolution_note=$3, resolved_at=CASE WHEN $2='resolved' THEN NOW() ELSE NULL END
         WHERE id=$1`,
        [escalationId, status, resolutionNote || null]
      );
      return successResponse(null, 'Escalation updated');
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // WEBSOCKET GATEWAY — real-time chat delivery
  // Mirrors tier-rooms.gateway.ts auth/connection pattern, scoped
  // to material chat rooms instead of tier rooms.
  // ─────────────────────────────────────────────────────────────
  @WebSocketGateway({
    namespace: '/material-chat',
    cors: {
      origin: ['http://localhost:3000', 'https://admin.bpscnotes.in'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  })
  @Injectable()
  export class MaterialChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer() server!: Server;
  
    private readonly logger = new Logger(MaterialChatGateway.name);
    private readonly socketUsers = new Map<string, string>();   // socketId -> userId
    private readonly lastMsgTime  = new Map<string, number>();   // userId -> ts (rate limit)
  
    constructor(
      private readonly jwtService: JwtService,
      private readonly config: ConfigService,
      private readonly chatService: MaterialChatService,
      @InjectDataSource() private readonly db: DataSource,
    ) {}
  
    afterInit() {
      this.logger.log('MaterialChatGateway initialised');
    }
  
    async handleConnection(client: Socket) {
      try {
        const token = this.extractToken(client);
        if (!token) throw new WsException('No auth token');
  
        const payload = this.jwtService.verify(token, {
          secret: this.config.get<string>('jwt.secret'),
        }) as { userId: string };
        if (!payload?.userId) throw new WsException('Invalid token');
  
        (client as any).userId = payload.userId;
        this.socketUsers.set(client.id, payload.userId);
        this.logger.log(`WS connected: user=${payload.userId} socket=${client.id}`);
      } catch (err: any) {
        this.logger.warn(`WS auth failed: ${err.message}`);
        client.emit('error', { message: 'Authentication failed' });
        client.disconnect();
      }
    }
  
    handleDisconnect(client: Socket) {
      this.socketUsers.delete(client.id);
    }
  
    private extractToken(client: Socket): string | null {
      return (
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '') ||
        null
      );
    }
  
    // ── CLIENT: join a chat thread room ─────────────────────────
    @SubscribeMessage('chat:join')
    async handleJoin(@ConnectedSocket() client: Socket, @MessageBody() data: { chatId: string }) {
      const userId = (client as any).userId as string;
      const chatId = data?.chatId;
      if (!userId || !chatId) throw new WsException('chatId required');
  
      const [chat] = await this.db.query(`SELECT buyer_id, uploader_id FROM material_chats WHERE id=$1`, [chatId]);
      if (!chat) throw new WsException('Chat not found');
      if (chat.buyer_id !== userId && chat.uploader_id !== userId) {
        throw new WsException('Not part of this conversation');
      }
  
      client.join(`chat:${chatId}`);
      return { event: 'chat:joined', chatId };
    }
  
    @SubscribeMessage('chat:leave')
    handleLeave(@ConnectedSocket() client: Socket, @MessageBody() data: { chatId: string }) {
      if (data?.chatId) client.leave(`chat:${data.chatId}`);
    }
  
    // ── CLIENT: send a message ───────────────────────────────────
    @SubscribeMessage('chat:message')
    async handleMessage(@ConnectedSocket() client: Socket, @MessageBody() data: { chatId: string; message: string }) {
      const userId = (client as any).userId as string;
      const chatId = data?.chatId;
      const message = data?.message?.trim();
      if (!userId || !chatId || !message) return;
      if (message.length > 1000) throw new WsException('Message too long (max 1000 characters)');
  
      // Rate limit: 1 msg/sec per user
      const last = this.lastMsgTime.get(userId) ?? 0;
      if (Date.now() - last < 1000) throw new WsException('Too fast. Slow down.');
      this.lastMsgTime.set(userId, Date.now());
  
      const res = await this.chatService.sendMessage(chatId, userId, message);
      const saved = res.data;
  
      this.server.to(`chat:${chatId}`).emit('chat:new_message', {
        id: saved.id,
        chatId,
        senderId: saved.sender_id,
        message: saved.message,
        createdAt: saved.created_at,
      });
  
      return { event: 'chat:sent', id: saved.id };
    }
  }
  
  // ════════════════════════════════════════════════════════════
  // USER CONTROLLER #1 — POST /study-materials/:id/chat
  // Kept under study-materials (depth-2 path) since there's no
  // existing :id/chat route to collide with.
  // ════════════════════════════════════════════════════════════
  @ApiTags('Material Chat')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Controller('study-materials')
  export class MaterialChatStartController {
    constructor(private readonly svc: MaterialChatService) {}
  
    // ── Get-or-create a chat thread for a material (buyer only) ──
    @Post(':id/chat')
    @HttpCode(HttpStatus.OK)
    getOrCreateThread(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
      return this.svc.getOrCreateThread(id, r.user.id).then(successResponse);
    }
  }
  
  // ════════════════════════════════════════════════════════════
  // USER CONTROLLER #2 — /material-chats/*
  // Separate top-level path — avoids any :id collision with the
  // existing GET /study-materials/:id route (a literal segment like
  // "chats" would otherwise be swallowed by ParseUUIDPipe on :id
  // depending on controller registration order).
  // ════════════════════════════════════════════════════════════
  @ApiTags('Material Chat')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Controller('material-chats')
  export class MaterialChatController {
    constructor(private readonly svc: MaterialChatService) {}
  
    // ── My chat inbox (all threads as buyer or uploader) ──────────
    @Get()
    listThreads(@Req() r: any) {
      return this.svc.listThreads(r.user.id);
    }
  
    // ── Get one thread + messages ─────────────────────────────────
    @Get(':chatId')
    getThread(
      @Param('chatId', ParseUUIDPipe) chatId: string,
      @Query('page') page = 1,
      @Query('limit') limit = 50,
      @Req() r: any,
    ) {
      return this.svc.getThread(chatId, r.user.id, +page, +limit);
    }
  
    // ── Send a message (REST fallback) ─────────────────────────────
    @Post(':chatId/messages')
    @HttpCode(HttpStatus.OK)
    sendMessage(@Param('chatId', ParseUUIDPipe) chatId: string, @Body() b: any, @Req() r: any) {
      return this.svc.sendMessage(chatId, r.user.id, b?.message);
    }
  
    // ── Escalate to support ─────────────────────────────────────────
    @Post(':chatId/escalate')
    @HttpCode(HttpStatus.OK)
    escalate(@Param('chatId', ParseUUIDPipe) chatId: string, @Body() b: any, @Req() r: any) {
      return this.svc.escalate(chatId, r.user.id, b?.category, b?.reason);
    }
  }
  
  // ════════════════════════════════════════════════════════════
  // ADMIN CONTROLLER — /admin/support-escalations
  // ════════════════════════════════════════════════════════════
  @ApiTags('Admin — Support Escalations')
  @ApiBearerAuth()
  @Public()
  @UseGuards(AdminJwtGuard, PermissionGuard)
  @Controller('admin/support-escalations')
  export class AdminSupportEscalationsController {
    constructor(private readonly svc: MaterialChatService) {}
  
    @Get()
    @RequirePermission('study-materials')
    list(@Query() q: any) { return this.svc.adminListEscalations(q); }
  
    @Get(':id/chat')
    @RequirePermission('study-materials')
    getChat(@Param('id', ParseUUIDPipe) id: string) { return this.svc.adminGetEscalationChat(id); }
  
    @Patch(':id')
    @RequirePermission('study-materials')
    @HttpCode(HttpStatus.OK)
    update(@Param('id', ParseUUIDPipe) id: string, @Body() b: any) {
      return this.svc.adminUpdateEscalation(id, b?.status, b?.resolutionNote);
    }
  }
  
  // ════════════════════════════════════════════════════════════
  // MODULE
  // ════════════════════════════════════════════════════════════
  @Module({
    imports: [JwtModule, ConfigModule, AuthModule],
    controllers: [MaterialChatStartController, MaterialChatController, AdminSupportEscalationsController],
    providers: [MaterialChatService, MaterialChatGateway],
    exports: [MaterialChatService, MaterialChatGateway],
  })
  export class MaterialChatModule {}