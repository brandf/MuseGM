/**
 * FoundryVTT client for API communication via Socket.IO
 *
 * Connects to FoundryVTT using the proven 4-step authentication flow,
 * caches worldData in memory, and serves all queries from the snapshot.
 */
import { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { probeRestModule } from './rest-probe.js';
import type { ActorAttributeUpdateResult, ActorItemCreateSource, ActorSearchResult, CompendiumSearchResult, DiceRoll, DocumentVisibility, FoundryActor, FoundryItem, FoundryScene, FoundryWorld, ItemSearchResult, JournalPageCreateSource, WorldActor, WorldCombat, WorldData, WorldEffect, WorldItem, WorldJournal, WorldMessage, WorldScene, WorldUser } from './types.js';
export { probeRestModule };
export interface FoundryClientConfig {
    baseUrl: string;
    apiKey?: string;
    username?: string;
    password?: string;
    userId?: string;
    timeout?: number;
    retryAttempts?: number;
    retryDelay?: number;
    socketPath?: string;
    /** Opt-in gate for game-state mutations (FOUNDRY_WRITE_ENABLED). Default false. */
    writeEnabled?: boolean;
}
export interface SearchActorsParams {
    query?: string;
    type?: string;
    limit?: number;
}
export interface SearchItemsParams {
    query?: string;
    type?: string;
    rarity?: string;
    limit?: number;
}
export interface CompendiumSearchParams {
    query?: string;
    packType?: string;
    itemType?: string;
    spellLevel?: number;
    source?: string;
    compendiumId?: string;
    limit?: number;
    /** Opaque pagination cursor from a prior result's `nextCursor`. */
    cursor?: string;
}
/**
 * Shallow attribute patch for {@link FoundryClient.updateActorAttribute} (#143).
 *
 * Keys are dot-paths into the actor's `system` object (e.g.
 * `attributes.hp.value`, `currency.gp`, `spells.spell1.value`,
 * `attributes.exhaustion`). Values are the scalar to set at that path.
 */
export type AttributePatch = Record<string, number | string | boolean>;
export declare class FoundryClient {
    private http;
    private socket;
    private config;
    private _isConnected;
    private worldData;
    /** Set when the socket drops with a cache still loaded (#217). */
    private worldDataStale;
    /**
     * Last observed outcome of a REST request: false once one failed to reach
     * FoundryVTT at all (#217). Unused in Socket.IO mode.
     */
    private restLinkLive;
    constructor(config: FoundryClientConfig);
    /**
     * Connects to FoundryVTT.
     * REST API mode: probes the module's authenticated /api/world route
     * (`probeRestModule`); connected only once it answers with a JSON object.
     * Socket.IO mode: authenticates and loads full worldData.
     */
    connect(): Promise<void>;
    /**
     * Connects Socket.IO with an authenticated session and loads worldData.
     */
    private connectAndLoadWorld;
    /**
     * Applies a FoundryVTT `modifyDocument` broadcast to the cached world state (#205).
     *
     * Bound field rather than a method so the same reference can be passed to
     * `socket.off()` on teardown. Never throws: a malformed or unmodelled payload
     * leaves the cache untouched (and stale) rather than taking the connection down.
     */
    private onDocumentBroadcast;
    /**
     * Applies a FoundryVTT `userActivity` broadcast to cached presence (#218).
     *
     * Foundry emits this on login, on logout, and on ordinary activity, and it is
     * the only signal that moves `worldData.activeUsers` — that field is a
     * top-level `WorldData` entry, not a document collection, so the
     * `modifyDocument` path never touches it and `get_users` would otherwise
     * answer "who is connected?" from the connect-time snapshot forever.
     *
     * Bound field rather than a method so the same reference reaches `socket.off()`.
     * Never throws: an unrecognized payload leaves presence as it was.
     */
    private onUserActivity;
    /**
     * Reacts to the socket dropping on its own — server restart, network loss,
     * an idle timeout (#217).
     *
     * Clears the connected flag so `isConnected()` and `get_health_status` stop
     * claiming a live link, and marks the cached snapshot stale: nothing is
     * applying `modifyDocument` broadcasts while the socket is down, so whatever
     * is in `worldData` from here on is a point-in-time copy, not live state.
     * The cache is deliberately *kept* rather than dropped — a stale answer with
     * an honest connection line beats no answer at all — and Socket.IO's own
     * reconnect logic may bring the link back, at which point `refreshWorldData()`
     * resyncs it.
     *
     * Bound field rather than a method so the same reference reaches `socket.off()`.
     */
    /**
     * Reacts to socket.io bringing the link back up on its own (#217).
     *
     * `sessionSocketOptions` leaves socket.io-client's default
     * `reconnection: true` in place, so after a transient drop the manager
     * re-handshakes the SAME socket instance (the session cookie rides along in
     * `extraHeaders`) and the persistent `modifyDocument`/`userActivity`
     * listeners resume firing. Without this the connected flag would stay
     * latched off for the rest of the process while writes and broadcasts were
     * demonstrably working again.
     *
     * `worldDataStale` is deliberately *not* cleared: broadcasts emitted while
     * the socket was down were never delivered and are not replayed, so the
     * cache stays flagged until an explicit `refreshWorldData()`.
     *
     * Bound field rather than a method so the same reference reaches `socket.off()`.
     */
    private onSocketConnect;
    private onSocketDisconnect;
    /**
     * Closes the current socket and removes every persistent listener bound to
     * it. Used both by `disconnect()` and before a socket is replaced: a
     * superseded socket that kept its `disconnect` handler would otherwise clear
     * the connected flag of the live socket that replaced it when it finally
     * closed (`DiagnosticsClient.testAuthentication()` re-connects a live
     * client, so this is reachable in-repo).
     */
    private detachSocket;
    disconnect(): Promise<void>;
    /**
     * Reports whether the client currently has a live link to FoundryVTT (#217).
     *
     * Socket.IO mode answers from the socket itself rather than from a latched
     * flag, so a link that dropped without an explicit `disconnect()` — server
     * restart, network loss — reads as disconnected immediately, even if the
     * `disconnect` event has not been delivered yet. It tracks the socket in both
     * directions: an automatic reconnect (`onSocketConnect`) reads as connected
     * again rather than staying latched off.
     *
     * REST API mode (`FOUNDRY_API_KEY`) has no socket to ask, so it answers from
     * the last REST request that actually happened: a request that failed to
     * reach FoundryVTT (connection refused, reset, timed out) reads as
     * disconnected from then on, and the next request that gets through reads as
     * connected again. An HTTP error status does not count as a drop — the
     * server answered. This is a *last observed outcome*, not a live probe: it
     * cannot notice a server that went away between requests, and it never does
     * I/O of its own, because this accessor is synchronous and widely called.
     */
    isConnected(): boolean;
    /**
     * True when the cached snapshot is no longer being kept live by broadcasts —
     * i.e. the socket dropped after a world load (#217). Reads still answer from
     * the cache; this flags that the answer is a point-in-time copy.
     */
    isWorldDataStale(): boolean;
    /**
     * Returns true if worldData is available (Socket.IO mode connected).
     */
    hasWorldData(): boolean;
    /**
     * Re-emits 'world' on the existing socket to refresh the cached snapshot.
     *
     * Registers a one-shot 'world' listener and cleans it up on every exit
     * path (success, error, timeout) via `socket.off()` so that repeated
     * refreshes over a long-running session do not leak listener handles.
     */
    refreshWorldData(): Promise<void>;
    getWorldData(): WorldData | null;
    searchActors(params: SearchActorsParams): Promise<ActorSearchResult>;
    getActor(actorId: string): Promise<FoundryActor>;
    /**
     * Returns the raw WorldActor with the full system data (game-system specific).
     */
    getRawActor(actorId: string): WorldActor | undefined;
    /**
     * Patches attributes on an actor's `system` object (#143). WRITE — Socket.IO.
     *
     * `patch` keys are dot-paths into `actor.system` (e.g. `attributes.hp.value`,
     * `currency.gp`, `spells.spell1.value`, `attributes.exhaustion`). Each key is
     * prefixed with `system.` and sent through the Socket.IO `modifyDocument`
     * write protocol as an `Actor` `update` — matching FoundryVTT's own document
     * model (`Actor#update`). No REST call and no `apiKey` are involved.
     *
     * Client-side validation, using the actor's current data, rejects:
     *  - HP value exceeding `max + temp`,
     *  - spell-slot value exceeding its `max`,
     *  - exhaustion outside `0–10` (2024 rules) or `0–6` (2014 rules).
     *
     * @throws via `assertWriteable()` if `writeEnabled` is false or the socket
     *   is not connected; also if the id is malformed, the actor/path is missing,
     *   or a validation rule is violated.
     */
    updateActorAttribute(actorId: string, patch: AttributePatch): Promise<ActorAttributeUpdateResult>;
    searchItems(params: SearchItemsParams): Promise<ItemSearchResult>;
    /**
     * Searches FoundryVTT compendium packs by name and metadata.
     *
     * Compendium data is not present in the cached worldData snapshot, so this
     * read requires the REST API module (FOUNDRY_API_KEY). When the key is
     * absent it returns a graceful empty result with `restAvailable: false`
     * rather than throwing, mirroring the no-worldData behaviour of
     * {@link searchItems}/{@link searchActors}; the handler surfaces a note
     * explaining why no results were returned.
     */
    searchCompendium(params: CompendiumSearchParams): Promise<CompendiumSearchResult>;
    /**
     * Guards a write operation. Writes require the `FOUNDRY_WRITE_ENABLED` opt-in
     * and an active authenticated Socket.IO session (the primary transport).
     * Throws a clear, actionable error otherwise.
     */
    private assertWriteable;
    /**
     * Emits a Socket.IO event with an acknowledgement callback, resolving the
     * server's response and rejecting on timeout. Mirrors the ack pattern used by
     * the `world` event in {@link connectAndLoadWorld}/{@link refreshWorldData}.
     */
    private emitWithAck;
    /**
     * Performs a FoundryVTT document mutation over Socket.IO using the core
     * `modifyDocument` protocol. The request shape is verified against the
     * v13.348 client source (`client/data/client-backend.mjs` `#buildRequest`,
     * `helpers/socket-interface.mjs` `dispatch`, `common/abstract/socket.mjs`).
     *
     * @param type - Document name ("Actor", "Item", …)
     * @param action - "create" | "update" | "delete"
     * @param operation - action-specific payload: `data` (create) / `updates`
     *   (update) / `ids` (delete), plus `parentUuid` for embedded documents.
     * @returns the server's `result` array (created/updated data, or deleted ids)
     */
    private modifyDocument;
    /**
     * Creates a new item on an actor via the `modifyDocument` socket protocol.
     *
     * Inline sources are created directly. Compendium sources are NOT yet
     * supported over Socket.IO — copying a pack entry needs a compendium read
     * that `modifyDocument` does not provide (tracked in issue #159).
     *
     * @param actorId - 16-char alphanumeric actor document id
     * @param source - inline item document (compendium source throws)
     * @returns the newly created item document
     */
    createActorItem(actorId: string, source: ActorItemCreateSource): Promise<FoundryItem>;
    /**
     * Applies a JSON merge patch to an item owned by an actor.
     *
     * The `patch` is merged into the item's `system` data (recursively, so nested
     * paths like the D&D 5e v4+ `activities.{id}.consumption.targets` are
     * preserved). Performed via the `modifyDocument` socket protocol.
     *
     * @param actorId - 16-char alphanumeric actor document id
     * @param itemId - 16-char alphanumeric item document id
     * @param patch - shallow/nested JSON merge patch applied to `item.system`
     * @returns the updated item document
     */
    updateActorItem(actorId: string, itemId: string, patch: Record<string, unknown>): Promise<FoundryItem>;
    /**
     * Deletes an item owned by an actor via the `modifyDocument` socket protocol.
     *
     * @param actorId - 16-char alphanumeric actor document id
     * @param itemId - 16-char alphanumeric item document id
     */
    deleteActorItem(actorId: string, itemId: string): Promise<void>;
    /**
     * Updates the active combat's turn/round pointers (FR-018).
     *
     * `Combat` is a top-level document, so the update carries no `parentUuid`.
     * The patch fields map directly onto the Combat document (`turn`, `round`).
     *
     * @param combatId - 16-char alphanumeric Combat document id
     * @param patch - turn and/or round to set on the combat
     * @returns the updated combat document
     */
    updateCombat(combatId: string, patch: {
        turn?: number;
        round?: number;
    }): Promise<unknown>;
    /**
     * Ends (deletes) the active combat encounter (FR-018).
     *
     * @param combatId - 16-char alphanumeric Combat document id
     */
    endCombat(combatId: string): Promise<void>;
    /**
     * Sets a combatant's initiative (FR-018).
     *
     * `Combatant` is an embedded document inside `Combat`, so the update is sent
     * with `parentUuid: "Combat.<combatId>"`.
     *
     * @param combatId - 16-char alphanumeric Combat document id (the parent)
     * @param combatantId - 16-char alphanumeric Combatant document id
     * @param initiative - finite initiative value to assign
     * @returns the updated combatant document
     */
    setCombatantInitiative(combatId: string, combatantId: string, initiative: number): Promise<unknown>;
    /**
     * Starts a new combat encounter and seeds its combatants (FR-018, #172).
     *
     * Two-step `modifyDocument` flow:
     *   1. Create the top-level `Combat` document (no `parentUuid`), activated on
     *      the given scene, and read its `_id` from the response.
     *   2. Create the embedded `Combatant` documents with
     *      `parentUuid: "Combat.<combatId>"` (mirrors the Combatant→Combat embed
     *      used by {@link setCombatantInitiative}).
     *
     * The create wire shape is verified against the v13.348 client source per
     * `.claude/rules/foundry-write-protocol.md`; smoke-test one live round-trip
     * when changing it.
     *
     * @param sceneId - 16-char alphanumeric Scene document id the combat runs on
     * @param combatants - combatant seeds ({ tokenId, sceneId, actorId? })
     * @returns the new combat id and the number of combatants created
     */
    startCombat(sceneId: string, combatants: Array<{
        tokenId: string;
        sceneId: string;
        actorId?: string | undefined;
    }>): Promise<{
        combatId: string;
        combatantCount: number;
    }>;
    /**
     * Locates a token (and the scene it lives on) in the cached worldData.
     *
     * `Token` is an embedded document of `Scene`; worldData carries each scene's
     * tokens as raw records. When `sceneId` is omitted the search spans every
     * scene, so a token can be moved/affected without first resolving its scene.
     *
     * @param tokenId - 16-char alphanumeric Token document id
     * @param sceneId - optional Scene id to scope the search to
     * @returns the owning scene and the raw token record, or null if not found
     */
    findToken(tokenId: string, sceneId?: string): {
        scene: WorldScene;
        token: Record<string, unknown>;
    } | null;
    /**
     * Moves a token to new x/y coordinates (FR-019).
     *
     * `Token` is an embedded document of `Scene`, so the update is sent with
     * `parentUuid: "Scene.<sceneId>"` (mirrors the Combatant→Combat embed). The
     * wire shape is verified against the v13.348 client source per
     * `.claude/rules/foundry-write-protocol.md`.
     *
     * @param sceneId - 16-char alphanumeric Scene document id (the parent)
     * @param tokenId - 16-char alphanumeric Token document id
     * @param x - target x pixel coordinate (finite number)
     * @param y - target y pixel coordinate (finite number)
     * @returns the updated token document
     */
    moveToken(sceneId: string, tokenId: string, x: number, y: number): Promise<unknown>;
    /**
     * Creates a status-effect `ActiveEffect` on a token's actor (FR-019).
     *
     * `ActiveEffect` is an embedded document of `Actor`, so the create is sent with
     * the actor's parent UUID:
     *  - `Actor.<id>` for a world-linked actor (`actorLink: true`)
     *  - `Scene.<sid>.Token.<tid>.Actor.<aid>` for an unlinked token's synthetic
     *    actor (the per-token delta).
     *
     * The effect carries a `statuses` array, matching how FoundryVTT v11+ models
     * conditions (`Actor#toggleStatusEffect` toggles by this field).
     *
     * @param parentActorUuid - the token actor's parent UUID (see forms above)
     * @param statusId - condition id (e.g. "prone", "stunned")
     * @param options - optional display `name` (defaults to `statusId`) and `img`
     * @returns the newly created ActiveEffect document
     */
    createActorStatusEffect(parentActorUuid: string, statusId: string, options?: {
        name?: string;
        img?: string;
    }): Promise<WorldEffect>;
    /**
     * Deletes an `ActiveEffect` from a token's actor (FR-019), e.g. to clear a
     * status condition. Accepts the same parent-UUID forms as
     * {@link createActorStatusEffect}.
     *
     * @param parentActorUuid - the token actor's parent UUID
     * @param effectId - 16-char alphanumeric ActiveEffect document id
     */
    deleteActorEffect(parentActorUuid: string, effectId: string): Promise<void>;
    getCurrentScene(sceneId?: string): Promise<FoundryScene>;
    getScene(sceneId: string): Promise<FoundryScene>;
    getScenes(): WorldScene[];
    getWorldInfo(): Promise<FoundryWorld>;
    getCombatState(): WorldCombat | null;
    getChatMessages(limit?: number): WorldMessage[];
    getUsers(): {
        users: WorldUser[];
        activeUsers: string[];
    };
    getJournals(): WorldJournal[];
    searchJournals(query: string): WorldJournal[];
    getJournal(journalId: string): WorldJournal | undefined;
    /**
     * Creates a new JournalEntry with one or more text pages.
     *
     * `JournalEntry` is a top-level document (unlike Item/ActiveEffect, which
     * are embedded in an Actor), so the create carries no `parentUuid` —
     * mirrors {@link startCombat}'s top-level Combat create. Each entry in
     * `pages` is mapped to Foundry's native `JournalEntryPage` text-page shape,
     * with an explicit `sort` so the pages render in the order supplied.
     *
     * @param name - journal entry title
     * @param pages - one or more pages (name + content); at least one required
     * @param folder - optional 16-char Folder document id to file the entry under
     * @param visibility - who can see the entry (#204); omitted means GM-only,
     *   which is FoundryVTT's default for a newly created document
     * @returns the newly created journal entry document
     */
    createJournalEntry(name: string, pages: JournalPageCreateSource[], folder?: string, visibility?: DocumentVisibility): Promise<WorldJournal>;
    searchWorld(query: string): {
        actors: WorldActor[];
        items: WorldItem[];
        scenes: WorldScene[];
        journals: WorldJournal[];
    };
    getWorldSummary(): Record<string, number>;
    /**
     * Rolls a dice formula.
     *
     * Validation is deliberately **per transport**, because the two transports
     * are not equally capable (#219):
     *
     *  - **REST (`FOUNDRY_API_KEY`)** posts the formula to `/api/dice/roll`,
     *    where FoundryVTT's own `Roll` engine evaluates it. That engine
     *    understands more than this module does — parentheses, for one — so only
     *    the `DICE_FORMULA_ALPHABET` check applies here. Imposing the local
     *    parser's narrower grammar would take away a capability the transport
     *    has. What the alphabet does refuse is refused by name and position
     *    (`unexpected "k" at position 3`, via `alphabetViolation`), so the
     *    two transports are equally specific about what they would not evaluate.
     *  - **Socket.IO / no API key** has no remote evaluator: `fallbackDiceRoll`
     *    is the roller, so the grammar its parser can represent is the grammar
     *    accepted, and that parser is the *only* gate. No alphabet pre-check runs
     *    ahead of it, so its specific message (`unexpected "k" at position 3`)
     *    reaches the caller instead of a generic `Invalid dice formula: 4d6kh3`.
     *    Nothing is ever dropped from a total in silence.
     *
     * The length cap is common to both. A REST roll that cannot reach FoundryVTT
     * falls through to the local roller, which then applies the strict grammar —
     * a formula only Foundry could evaluate errors out rather than being
     * mis-totalled locally.
     */
    rollDice(formula: string, reason?: string): Promise<DiceRoll>;
    /**
     * Rolls locally, when FoundryVTT is not doing it for us.
     *
     * Delegates the whole formula to {@link evaluateDiceFormula}, which consumes
     * the input end to end and throws on any leftover it cannot represent (#219).
     */
    private fallbackDiceRoll;
    testConnection(): Promise<boolean>;
    private executeWithRetry;
    get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
    post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
    put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
    delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
}
//# sourceMappingURL=client.d.ts.map