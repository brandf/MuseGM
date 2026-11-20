/**
 * foundry-live — public API.
 *
 * A small high-level client for talking to a Foundry VTT world live over the
 * MIT laurigates MCP client (Socket.IO). See README.md for setup and the
 * two gotchas this library exists to absorb (the Origin header on login,
 * and ChatMessage's `author` field).
 */
export { FoundryLive } from "./live.js";
export { ChatStyle } from "./types.js";
export type { PingStyle, PingOptions } from "./live.js";
export { moveTokenTo, placeToken, deleteToken, resolveScene, resolveToken, getSceneTokens } from "./session/movement.js";
export type { SceneToken, MoveResult, TokenRef } from "./session/movement.js";
export { runSequence } from "./session/sequence.js";
export type { SequenceStep, StepResult, SequenceResult, RunSequenceOptions } from "./session/sequence.js";
export type {
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
