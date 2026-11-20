/**
 * Public types for foundry-live.
 *
 * Foundry 13+ renamed ChatMessage's `user` field to `author`. The wire data
 * carries `author`; this library normalizes both spellings so callers never
 * have to care.
 */

/** How to reach a Foundry server. All fields default from the environment. */
export interface FoundryLiveConfig {
  /** Foundry base URL, e.g. http://host:30000. Default: FOUNDRY_URL. */
  url?: string;
  /** Foundry username. Default: FOUNDRY_USERNAME. */
  username?: string;
  /** Foundry password. Default: FOUNDRY_PASSWORD. Never log this. */
  password?: string;
  /** Foundry user document _id (16 chars). Default: FOUNDRY_USER_ID, else resolved by username. */
  userId?: string;
  /** Opt-in gate for game-state writes (chat, combat, tokens). Default: true. */
  writeEnabled?: boolean;
  /** Socket/HTTP timeout in ms. Default: 15000. */
  timeout?: number;
}

/** Chat message styles (Foundry CHAT_MESSAGE_STYLES). */
export const ChatStyle = {
  Other: 0,
  OOC: 1,
  IC: 2,
  Emote: 3,
} as const;

/** One normalized Foundry chat message. */
export interface ChatMessage {
  /** Message document _id. */
  id: string;
  /** Authoring user document _id. */
  author: string;
  /** Speaker block (alias is the display name shown in chat). */
  speaker?: { alias?: string; actor?: string; token?: string; scene?: string };
  /** Message body (HTML). */
  content: string;
  /** ChatMessage style: 0 other, 1 ooc, 2 ic, 3 emote. */
  style: number;
  /** Unix epoch ms. */
  timestamp: number;
  /** Flavor text (rolls). */
  flavor?: string;
  /** Whisper recipients (user _ids), if any. */
  whisper?: string[];
}

/** Options for {@link FoundryLive.sendChat}. */
export interface SendChatOptions {
  /** Display name shown in chat. Default: "Meroki". */
  alias?: string;
  /** Chat style. Default: 1 (OOC). */
  style?: number;
  /** Whisper to these user _ids (empty = public). */
  whisperTo?: string[];
}

/** Options for {@link FoundryLive.waitForChat}. */
export interface WaitForChatOptions {
  /** Message _id to start after. Messages already past it are returned immediately. */
  lastSeen?: string | null;
  /** Seconds to wait before giving up. Default: 120. */
  timeout?: number;
  /** Seconds to wait after the first new message to merge a burst. Default: 3. */
  debounce?: number;
  /** If false (default), our own messages never wake the waiter. */
  includeOwn?: boolean;
}

/** Result of {@link FoundryLive.waitForChat}. */
export interface WaitResult {
  /** True when the timeout expired with nothing new. */
  timedOut: boolean;
  /** New messages after `lastSeen`, oldest first. */
  newMessages: ChatMessage[];
  /** _id of the newest message seen (== input lastSeen when nothing new). */
  lastSeen: string | null;
}

/** Events a long-running watcher can queue and deliver. */
export type FoundryEvent =
  | { kind: "chat"; message: ChatMessage }
  | {
      kind: "document";
      type: string;
      action: "create" | "update" | "delete";
      docs: Record<string, unknown>[];
    };

export type FoundryEventListener = (event: FoundryEvent) => void;

/** A dice roll result (rolled locally by the MCP client in Socket.IO mode). */
export interface DiceRollResult {
  formula: string;
  total: number;
  breakdown: string;
  reason?: string;
  timestamp: string;
  /** 'server' when Foundry evaluated it, 'local' when the client did. */
  source: "server" | "local";
}

/** World counts, as returned by getWorldSummary(). */
export interface WorldSummary {
  title?: string;
  system?: string;
  systemVersion?: string;
  coreVersion?: string;
  counts: Record<string, number>;
}
