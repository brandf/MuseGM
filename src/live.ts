/**
 * FoundryLive — a small high-level client for talking to a Foundry VTT world
 * live over the MIT laurigates MCP client (Socket.IO transport).
 *
 * Design notes:
 * - The vendored MCP client keeps a live worldData cache that is updated by
 *   `modifyDocument` socket broadcasts. Reads come from that cache; writes go
 *   out over the same socket.
 * - Chat send is NOT a tool in the upstream MCP (33 tools, none posts chat).
 *   It works through the same `modifyDocument` protocol with document type
 *   `ChatMessage`. Foundry 13+ requires the `author` field (not `user`):
 *   sending `user` fails validation with "author: may not be null".
 * - The vendored client is patched for Foundry 14.370: POST /join needs an
 *   `Origin` header or the server 400s (see vendor/foundryvtt-mcp/PATCH.md).
 * - waitForChat wakes on socket broadcasts (sub-second) with a 1s poll as a
 *   fallback, so a missed broadcast can only delay a wake-up by ~1s.
 */
import { FoundryClient } from "../vendor/foundryvtt-mcp/dist/foundry/client.js";
import { evaluateDiceFormula } from "../vendor/foundryvtt-mcp/dist/foundry/dice-formula.js";
import {
  FLAG_FIELDS,
  flagValue,
  hashStringToSeed,
  rngFromSeed,
  findMessageByDedupeKey as findKeyedMessage,
} from "./idempotency.js";
import type { DedupeMessage } from "./idempotency.js";
import type {
  ChatMessage,
  DiceRollResult,
  FoundryEvent,
  FoundryEventListener,
  FoundryLiveConfig,
  SendChatOptions,
  WaitForChatOptions,
  WaitResult,
  WorldSummary,
} from "./types.js";

type RawMessage = Record<string, unknown>;

function normalizeMessage(raw: RawMessage): ChatMessage {
  const speaker = raw.speaker as ChatMessage["speaker"];
  return {
    id: String(raw._id ?? ""),
    author: String(
      (raw.author as string | undefined) ?? (raw.user as string | undefined) ?? "",
    ),
    speaker: speaker
      ? {
          alias: speaker.alias,
          actor: speaker.actor,
          token: speaker.token,
          scene: speaker.scene,
        }
      : undefined,
    content: String(raw.content ?? ""),
    style: Number((raw.style as number | undefined) ?? (raw.type as number | undefined) ?? 0),
    timestamp: Number(raw.timestamp ?? 0),
    flavor: raw.flavor as string | undefined,
    whisper: raw.whisper as string[] | undefined,
  };
}

interface RawSocket {
  on(event: string, cb: (payload: unknown) => void): void;
  off(event: string, cb: (payload: unknown) => void): void;
  emit(event: string, ...args: unknown[]): void;
  volatile: { emit(event: string, ...args: unknown[]): void };
}

export type PingStyle = "pulse" | "alert" | "pull" | "arrow";

export interface PingOptions {
  /** Scene _id. Defaults to the active scene. */
  sceneId?: string;
  /** Ping style. Default "pulse". "pull" is the GM pull ping (chevron + pull). */
  style?: PingStyle;
  /** Pull every connected client's view to the ping. Default false (true when style is "pull"). */
  pull?: boolean;
  /** Canvas zoom to report with the ping. Default 1. */
  zoom?: number;
}

interface ModifyDocumentClient {
  modifyDocument(
    type: string,
    action: "create" | "update" | "delete" | "get",
    operation: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
}

export class FoundryLive {
  private client: FoundryClient;
  private ownUserId: string | null = null;
  private username: string;
  private listeners = new Set<FoundryEventListener>();
  private queue: FoundryEvent[] = [];
  private waiters: Array<(event: FoundryEvent) => void> = [];
  private socketHandler: ((payload: unknown) => void) | null = null;
  private watching = false;
  /**
   * Last ping / cursor point per user, from the socket's `userActivity`
   * broadcasts — the same event this client emits for its own pings
   * (see ping()/moveCursor()), now also listened to. A ping is a
   * deliberate "here"; a cursor is where the mouse currently is. Each
   * keeps its own arrival time so `lastPointFor` can take the newer
   * of the two. Our own activity is ignored — our pings are never
   * the GM's "here".
   */
  private activityByUser = new Map<
    string,
    {
      ping?: { sceneId: string; x: number; y: number; at: number };
      cursor?: { x: number; y: number; at: number };
    }
  >();
  private activityHandler: ((...args: unknown[]) => void) | null = null;
  /**
   * Dedupe keys this connection has already sent, key -> message _id. The
   * world-payload scan (findMessageByDedupeKey) closes the cross-process
   * gap; this map closes the same-process gap, because a connection never
   * reliably sees its OWN creates in its worldData cache — without it, a
   * second sendChatIdempotent call with the same key in one process would
   * miss in the scan and post twice. The map remembers the id, so the
   * re-send returns the original message without touching the server.
   */
  private sentDedupeKeys = new Map<string, string>();

  private constructor(client: FoundryClient, username: string) {
    this.client = client;
    this.username = username;
  }

  /** Connect to Foundry. Config defaults come from FOUNDRY_URL / FOUNDRY_USERNAME / FOUNDRY_PASSWORD / FOUNDRY_USER_ID. */
  static async connect(config: FoundryLiveConfig = {}): Promise<FoundryLive> {
    const url = config.url ?? process.env.FOUNDRY_URL;
    const username = config.username ?? process.env.FOUNDRY_USERNAME;
    const password = config.password ?? process.env.FOUNDRY_PASSWORD;
    if (!url || !username || !password) {
      throw new Error(
        "Missing Foundry credentials: set FOUNDRY_URL, FOUNDRY_USERNAME and FOUNDRY_PASSWORD (or pass them in config).",
      );
    }
    const client = new FoundryClient({
      baseUrl: url,
      username,
      password,
      userId: config.userId ?? process.env.FOUNDRY_USER_ID,
      writeEnabled: config.writeEnabled ?? true,
      timeout: config.timeout ?? 15000,
    });
    await client.connect();
    const live = new FoundryLive(client, username);
    live.ownUserId = config.userId ?? process.env.FOUNDRY_USER_ID ?? null;
    if (!live.ownUserId) {
      const users = live.getUsers();
      const me = users.find((u) => u.name?.toLowerCase() === username.toLowerCase());
      live.ownUserId = me?._id ?? null;
    }
    return live;
  }

  /** Our own user document _id (resolved at connect). */
  get userId(): string | null {
    return this.ownUserId;
  }

  get connected(): boolean {
    return this.client.isConnected();
  }

  async disconnect(): Promise<void> {
    this.stopWatching();
    await this.client.disconnect();
  }

  /** The underlying vendored client, for advanced use. */
  raw(): FoundryClient {
    return this.client;
  }

  // ---------------------------------------------------------------- reads

  /** Most recent chat messages, oldest first. */
  getChatMessages(limit = 20): ChatMessage[] {
    return (this.client.getChatMessages(limit) as unknown as RawMessage[]).map(
      normalizeMessage,
    );
  }

  /** World metadata plus per-collection document counts. */
  getWorldSummary(): WorldSummary {
    const counts = this.client.getWorldSummary() as Record<string, number>;
    const data = this.client.getWorldData() as unknown as {
      world?: Record<string, unknown>;
      system?: Record<string, unknown>;
      release?: Record<string, unknown>;
    } | null;
    const release = data?.release;
    return {
      title: data?.world?.title as string | undefined,
      system: data?.system?.id as string | undefined,
      systemVersion: data?.system?.version as string | undefined,
      coreVersion:
        (release?.version as string | undefined) ??
        (release?.generation !== undefined ? String(release.generation) : undefined),
      counts,
    };
  }

  /** All users plus which are currently online. */
  getUsers(): { _id: string; name: string; role: number; active: boolean }[] {
    const { users, activeUsers } = this.client.getUsers() as {
      users: { _id: string; name: string; role: number }[];
      activeUsers: string[];
    };
    const active = new Set(activeUsers);
    return users.map((u) => ({ ...u, active: active.has(u._id) }));
  }

  /** The active combat encounter, or null when no combat is running. */
  getCombatState(): unknown {
    return this.client.getCombatState();
  }

  /** Details of the active scene (or `sceneId` when given). */
  async getSceneInfo(sceneId?: string): Promise<unknown> {
    return this.client.getCurrentScene(sceneId);
  }

  /** Search actors by name, optionally filtered by type. */
  async searchActors(
    query: string,
    opts: { type?: string; limit?: number } = {},
  ): Promise<unknown> {
    return this.client.searchActors({ query, ...opts });
  }

  /** Full details for one actor by document _id. */
  async getActorDetails(actorId: string): Promise<unknown> {
    return this.client.getActor(actorId);
  }

  /** Search across all collections (actors, items, scenes, journals) by name. */
  searchWorld(query: string): unknown {
    return this.client.searchWorld(query);
  }

  // ---------------------------------------------------------------- writes

  /**
   * Post a message to Foundry chat.
   *
   * There is no send-chat tool in the upstream MCP, so this goes through the
   * same `modifyDocument` socket protocol the MCP uses for journals/items,
   * with document type `ChatMessage`. Foundry 13+ wants `author`, not `user`.
   * Returns the created message document _id.
   *
   * When `opts.dedupeKey` is set, the key is stored in the message's flags
   * — but this method does NOT check for a previous send. Use
   * `sendChatIdempotent` for the check-then-send path (crash re-dispatch);
   * this method stays the plain "post it" primitive.
   */
  async sendChat(content: string, opts: SendChatOptions = {}): Promise<string> {
    if (!this.ownUserId) {
      throw new Error("Cannot send chat: own user _id is unknown (not resolved at connect).");
    }
    const doc: Record<string, unknown> = {
      content,
      speaker: { alias: opts.alias ?? "Meroki" },
      style: opts.style ?? 1,
      author: this.ownUserId,
    };
    if (opts.whisperTo && opts.whisperTo.length > 0) doc.whisper = opts.whisperTo;
    if (opts.dedupeKey) doc.flags = flagValue(FLAG_FIELDS.chatDedupe, opts.dedupeKey);
    const created = await this.modifyDocument("ChatMessage", "create", { data: [doc] });
    const id = String((created[0] as Record<string, unknown> | undefined)?._id ?? "");
    if (!id) throw new Error("Chat message create returned no _id.");
    if (opts.dedupeKey) this.sentDedupeKeys.set(opts.dedupeKey, id);
    return id;
  }

  /**
   * Find a message this user already posted with the given dedupe key, in
   * the last 50 chat messages. Returns undefined when nothing matches.
   * The scan is author-scoped: one Muse's key can never claim another
   * user's message.
   */
  findMessageByDedupeKey(dedupeKey: string): ChatMessage | undefined {
    const messages = this.getChatMessages(50) as unknown as DedupeMessage[];
    const found = findKeyedMessage(messages, dedupeKey, this.ownUserId ?? undefined);
    if (!found) return undefined;
    return this.getChatMessages(50).find((m) => m.id === found.id);
  }

  /**
   * Retry-safe send: post once, return the already-posted message on a
   * re-run instead of posting twice.
   *
   * Check order: (1) this connection's sent-keys map — covers a second
   * call in the same process, where the worldData cache cannot see our
   * own creates; (2) a scan of the last 50 chat messages for the key —
   * covers a fresh connection after a crash re-dispatch. Returns
   * `{ id, duplicate }` so the caller (and the phase-two layer) can tell
   * a re-run from a fresh send.
   *
   * Residual race, documented honestly: the check-then-create is not
   * atomic. Two processes racing with the same key can both miss and both
   * post. The realistic hazard — a crash re-dispatch — is sequential, so
   * the check closes it; true concurrency is not closed.
   */
  async sendChatIdempotent(
    content: string,
    opts: SendChatOptions & { dedupeKey: string },
  ): Promise<{ id: string; duplicate: boolean }> {
    if (!this.ownUserId) {
      throw new Error("Cannot send chat: own user _id is unknown (not resolved at connect).");
    }
    const key = opts.dedupeKey;
    const alreadySent = this.sentDedupeKeys.get(key);
    if (alreadySent) return { id: alreadySent, duplicate: true };
    const existing = this.findMessageByDedupeKey(key);
    if (existing) {
      this.sentDedupeKeys.set(key, existing.id);
      return { id: existing.id, duplicate: true };
    }
    const id = await this.sendChat(content, opts);
    return { id, duplicate: false };
  }

  /**
   * Roll dice. In Socket.IO mode the MCP rolls locally (Foundry's own Roll
   * engine is only reachable via the REST API module, which this setup does
   * not use), so `source` is 'local'. With `showInChat`, the result is also
   * posted to Foundry chat as a message.
   *
   * With `opts.seed`, the roll is deterministic: the formula is evaluated
   * with a seeded PRNG derived from the seed string, so a re-run with the
   * same seed reproduces the same total and breakdown. Seeded rolls are
   * always local (the server roller cannot be seeded). Use the seed
   * together with `dedupeKey` to make "roll and post" retry-safe end to
   * end: the re-run rolls the same number and finds the already-posted
   * message instead of posting a second, different roll.
   */
  async rollDice(
    formula: string,
    opts: { flavor?: string; showInChat?: boolean; seed?: string; dedupeKey?: string } = {},
  ): Promise<DiceRollResult> {
    let roll: DiceRollResult;
    if (opts.seed !== undefined) {
      const { total, breakdown } = evaluateDiceFormula(
        formula,
        rngFromSeed(hashStringToSeed(opts.seed)),
      );
      roll = {
        formula,
        total,
        breakdown,
        timestamp: new Date().toISOString(),
        source: "local",
      };
      if (opts.flavor) roll.reason = opts.flavor;
    } else {
      roll = (await this.client.rollDice(
        formula,
        opts.flavor,
      )) as unknown as DiceRollResult;
    }
    if (opts.showInChat) {
      const text = opts.flavor
        ? `🎲 ${opts.flavor}: ${roll.formula} = **${roll.total}** (${roll.breakdown})`
        : `🎲 ${roll.formula} = **${roll.total}** (${roll.breakdown})`;
      await this.sendChat(text, { dedupeKey: opts.dedupeKey });
    }
    return roll;
  }

  /** Low-level document operation over the Socket.IO `modifyDocument` protocol.
   *
   * Action "get" is a READ, not a mutation: `modifyDocument(type, "get",
   * { query, pack })` returns matching documents from a compendium pack
   * (see docs/compendium-import.md). The server's dispatch accepts it; the
   * vendored client's types only list the three write actions, so the union
   * here is deliberately wider than the vendored one. */
  async modifyDocument(
    type: string,
    action: "create" | "update" | "delete" | "get",
    operation: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    // modifyDocument is private on the vendored client's types; it is a
    // normal method at runtime and is the documented write transport.
    const c = this.client as unknown as ModifyDocumentClient;
    return c.modifyDocument(type, action, operation);
  }

  /** The _id of the currently active scene, or null when none is active. */
  getActiveSceneId(): string | null {
    const data = this.client.getWorldData() as unknown as {
      scenes?: { _id: string; active?: boolean }[];
    } | null;
    return data?.scenes?.find((s) => s.active)?._id ?? null;
  }

  /**
   * Ping the canvas at (x, y) — the `userActivity` socket message Foundry's
   * own client sends (verified in the Foundry 14 client bundle, Nov 19).
   *
   * The message carries the cursor position too, so a ping also moves the
   * GM's cursor as seen by other clients. Pings are scene-scoped: only
   * clients viewing that scene see them.
   *
   * Styles (CONFIG.Canvas.pings): "pulse" (default, 900ms), "alert" (red,
   * Alt-ping), "pull" (the GM pull ping — style "chevron", 2000ms, pulls
   * every client's view), "arrow". `pull: true` pulls views without
   * changing the style. Sent volatile — a dropped ping is just a dropped
   * ping, exactly like the real client does it.
   */
  async ping(x: number, y: number, opts: PingOptions = {}): Promise<{ sceneId: string; x: number; y: number; style: string; pull: boolean }> {
    if (!this.ownUserId) {
      throw new Error("Cannot ping: own user _id is unknown (not resolved at connect).");
    }
    const sceneId = opts.sceneId ?? this.getActiveSceneId();
    if (!sceneId) throw new Error("Cannot ping: no scene given and no scene is active.");
    const style = opts.style ?? "pulse";
    // The client's PULL ping is style "chevron" with pull: true.
    const wireStyle = style === "pull" ? "chevron" : style;
    const pull = opts.pull ?? style === "pull";
    const socket = this.rawSocket();
    if (!socket) throw new Error("Cannot ping: socket is not connected.");
    socket.volatile.emit("userActivity", this.ownUserId, {
      cursor: { x, y },
      ping: { scene: sceneId, pull, style: wireStyle, zoom: opts.zoom ?? 1 },
    });
    return { sceneId, x, y, style, pull };
  }

  /**
   * Move our cursor as seen by other clients, without a ping — same
   * `userActivity` message, cursor only. (x, y) are scene coordinates.
   */
  async moveCursor(x: number, y: number, opts: { sceneId?: string } = {}): Promise<{ sceneId: string; x: number; y: number }> {
    if (!this.ownUserId) {
      throw new Error("Cannot move cursor: own user _id is unknown (not resolved at connect).");
    }
    const sceneId = opts.sceneId ?? this.getActiveSceneId();
    if (!sceneId) throw new Error("Cannot move cursor: no scene given and no scene is active.");
    const socket = this.rawSocket();
    if (!socket) throw new Error("Cannot move cursor: socket is not connected.");
    socket.volatile.emit("userActivity", this.ownUserId, { cursor: { x, y } });
    return { sceneId, x, y };
  }

  // ---------------------------------------------------------------- events

  /** Subscribe to live events ('chat' and 'document' broadcasts). */
  on(listener: FoundryEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Next queued event, waiting until one arrives (or `timeoutMs` elapses -> null). */
  nextEvent(timeoutMs?: number): Promise<FoundryEvent | null> {
    this.startWatching();
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (event: FoundryEvent) => {
        if (timer) clearTimeout(timer);
        resolve(event);
      };
      this.waiters.push(waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, timeoutMs);
      }
    });
  }

  private emit(event: FoundryEvent): void {
    this.queue.push(event);
    const waiter = this.waiters.shift();
    if (waiter) {
      this.queue.shift();
      waiter(event);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken listener must never take the watcher down.
      }
    }
  }

  private rawSocket(): RawSocket | null {
    const c = this.client as unknown as { socket?: RawSocket | null };
    return c.socket ?? null;
  }

  /**
   * Attach to the socket's `modifyDocument` broadcasts. The vendored client's
   * own listener (attached at connect) updates its worldData cache first, so
   * by the time this handler runs the cache already holds the new document.
   * A 1s poll in waitForChat covers a broadcast we somehow miss.
   */
  private startWatching(): void {
    if (this.watching) return;
    const socket = this.rawSocket();
    if (!socket) return;
    this.watching = true;
    this.socketHandler = (payload: unknown) => {
      const p = payload as {
        type?: string;
        action?: string;
        result?: Record<string, unknown>[];
      };
      if (!p || typeof p.type !== "string") return;
      const docs = Array.isArray(p.result) ? p.result : [];
      this.emit({
        kind: "document",
        type: p.type,
        action: (p.action as "create" | "update" | "delete") ?? "update",
        docs,
      });
      if (p.type === "ChatMessage" && p.action === "create") {
        for (const doc of docs) {
          this.emit({ kind: "chat", message: normalizeMessage(doc) });
        }
        // Wake a waitForChat in progress right away; its debounce timer
        // then merges the rest of the burst before it returns.
        this.chatTrigger?.();
      }
    };
    socket.on("modifyDocument", this.socketHandler);
    // Incoming userActivity: other clients' pings and cursor moves.
    // Foundry relays a client's own emit to the rest of the room, so
    // this is how the GM's "here" reaches us — no new protocol, the
    // same event ping()/moveCursor() already send.
    this.activityHandler = (...args: unknown[]) => {
      const [userId, activity] = args as [unknown, Record<string, unknown> | undefined];
      if (typeof userId !== "string" || !activity || typeof activity !== "object") return;
      if (userId === this.ownUserId) return;
      const rec = this.activityByUser.get(userId) ?? {};
      const now = Date.now();
      const cursor = activity.cursor as { x?: unknown; y?: unknown } | undefined;
      if (cursor && typeof cursor.x === "number" && typeof cursor.y === "number") {
        rec.cursor = { x: cursor.x, y: cursor.y, at: now };
      }
      const ping = activity.ping as { scene?: unknown; x?: unknown; y?: unknown } | undefined;
      if (
        ping &&
        typeof ping.scene === "string" &&
        typeof ping.x === "number" &&
        typeof ping.y === "number"
      ) {
        rec.ping = { sceneId: ping.scene, x: ping.x, y: ping.y, at: now };
      }
      if (rec.cursor || rec.ping) this.activityByUser.set(userId, rec);
    };
    socket.on("userActivity", this.activityHandler);
  }

  private stopWatching(): void {
    const socket = this.rawSocket();
    if (socket && this.socketHandler) socket.off("modifyDocument", this.socketHandler);
    if (socket && this.activityHandler) socket.off("userActivity", this.activityHandler);
    this.socketHandler = null;
    this.activityHandler = null;
    this.watching = false;
  }

  /**
   * A user's most recent ping or cursor point, whichever arrived
   * last — the "here" for a build request. A ping carries its scene;
   * a cursor doesn't (it is on whatever scene the user is viewing),
   * so the caller pairs a cursor-only point with the active room.
   * Returns null when we've seen no activity from that user (e.g.
   * the monitor started after the ping, or the user never pinged).
   */
  lastPointFor(
    userId: string,
  ): { sceneId?: string; x: number; y: number; kind: "ping" | "cursor"; at: number } | null {
    const rec = this.activityByUser.get(userId);
    if (!rec) return null;
    const { ping, cursor } = rec;
    if (ping && (!cursor || ping.at >= cursor.at)) {
      return { sceneId: ping.sceneId, x: ping.x, y: ping.y, kind: "ping", at: ping.at };
    }
    if (cursor) return { x: cursor.x, y: cursor.y, kind: "cursor", at: cursor.at };
    return null;
  }

  /**
   * Block until new chat arrives, or the timeout expires.
   *
   * Wake-up path: the socket broadcast fires the moment Foundry relays the
   * new ChatMessage (sub-second). A 1s poll is kept as a fallback in case a
   * broadcast is missed. After the first new message, `debounce` seconds are
   * spent merging follow-ups in the same burst before returning.
   *
   * Messages already past `lastSeen` when the wait starts are returned
   * immediately (a burst that happened before we started waiting is over).
   * Our own messages never wake the waiter (unless `includeOwn`).
   */
  async waitForChat(opts: WaitForChatOptions = {}): Promise<WaitResult> {
    const timeoutMs = (opts.timeout ?? 120) * 1000;
    const debounceMs = (opts.debounce ?? 3) * 1000;
    const includeOwn = opts.includeOwn ?? false;
    const isOwn = (m: ChatMessage): boolean =>
      (!!this.ownUserId && m.author === this.ownUserId) ||
      m.speaker?.alias === "Meroki";

    const messagesAfter = (lastSeen: string | null): ChatMessage[] => {
      const all = this.getChatMessages(50);
      if (!lastSeen) return all;
      const idx = all.findIndex((m) => m.id === lastSeen);
      return idx === -1 ? all : all.slice(idx + 1);
    };

    let lastSeen = opts.lastSeen ?? null;

    // Backlog: already-new messages return immediately, no debounce.
    const backlog = messagesAfter(lastSeen);
    if (backlog.length > 0) {
      const newest = backlog[backlog.length - 1];
      return { timedOut: false, newMessages: backlog, lastSeen: newest.id };
    }

    this.startWatching();
    return new Promise((resolve) => {
      let done = false;
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (timedOut: boolean) => {
        if (done) return;
        done = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.offChatTrigger();
        const fresh = messagesAfter(lastSeen);
        resolve({
          timedOut,
          newMessages: fresh,
          lastSeen: fresh.length > 0 ? fresh[fresh.length - 1].id : lastSeen,
        });
      };

      // Fires on the first qualifying new message; debounce merges the burst.
      const trigger = () => {
        if (done || debounceTimer) return;
        debounceTimer = setTimeout(() => finish(false), debounceMs);
      };

      const check = () => {
        const fresh = messagesAfter(lastSeen);
        const waking = includeOwn ? fresh : fresh.filter((m) => !isOwn(m));
        if (waking.length > 0) trigger();
      };

      this.chatTrigger = check;
      pollTimer = setInterval(check, 1000);
      timeoutTimer = setTimeout(() => finish(true), timeoutMs);
    });
  }

  private chatTrigger: (() => void) | null = null;

  private offChatTrigger(): void {
    this.chatTrigger = null;
  }
}
