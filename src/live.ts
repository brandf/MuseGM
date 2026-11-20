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
    action: "create" | "update" | "delete",
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
    const created = await this.modifyDocument("ChatMessage", "create", { data: [doc] });
    const id = String((created[0] as Record<string, unknown> | undefined)?._id ?? "");
    if (!id) throw new Error("Chat message create returned no _id.");
    return id;
  }

  /**
   * Roll dice. In Socket.IO mode the MCP rolls locally (Foundry's own Roll
   * engine is only reachable via the REST API module, which this setup does
   * not use), so `source` is 'local'. With `showInChat`, the result is also
   * posted to Foundry chat as a message.
   */
  async rollDice(
    formula: string,
    opts: { flavor?: string; showInChat?: boolean } = {},
  ): Promise<DiceRollResult> {
    const roll = (await this.client.rollDice(
      formula,
      opts.flavor,
    )) as unknown as DiceRollResult;
    if (opts.showInChat) {
      const text = opts.flavor
        ? `🎲 ${opts.flavor}: ${roll.formula} = **${roll.total}** (${roll.breakdown})`
        : `🎲 ${roll.formula} = **${roll.total}** (${roll.breakdown})`;
      await this.sendChat(text);
    }
    return roll;
  }

  /** Low-level document mutation over the Socket.IO `modifyDocument` protocol. */
  async modifyDocument(
    type: string,
    action: "create" | "update" | "delete",
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
  }

  private stopWatching(): void {
    const socket = this.rawSocket();
    if (socket && this.socketHandler) socket.off("modifyDocument", this.socketHandler);
    this.socketHandler = null;
    this.watching = false;
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
