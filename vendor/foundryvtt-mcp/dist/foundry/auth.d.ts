/**
 * FoundryVTT authentication module
 *
 * Implements the proven 4-step authentication flow for direct WebSocket access:
 * 1. GET /join → session cookie
 * 2. Socket.IO connect + getJoinData → resolve user document _id
 * 3. POST /join as JSON with document _id → authenticated session
 * 4. Socket.IO reconnect with session → full game state access
 */
import type { ManagerOptions, SocketOptions } from 'socket.io-client';
/**
 * Socket.IO connection options carrying a FoundryVTT session.
 *
 * The session is sent twice, and both copies are load-bearing — do not drop
 * either. Per #231, FoundryVTT v14 resolves the session from the `session`
 * **cookie** on the handshake request, while v13 reads it from
 * `handshake.query` (not yet verified against a server; tracked in #253).
 * A socket whose server finds no session still connects at the transport
 * level — it simply never answers `getJoinData` and emits `session` as
 * `null` — so the only symptom of losing either copy is a bare timeout with
 * no `connect_error` (#206).
 *
 * `extraHeaders` is honoured by socket.io-client in Node.js for both the
 * WebSocket and polling handshakes.
 *
 * `path` is the server's Socket.IO endpoint (`FOUNDRY_SOCKET_PATH`): behind a
 * `routePrefix` it is `/<prefix>/socket.io/` (#231). Pair it with
 * {@link socketOrigin} — the URL handed to `io()` must not carry the prefix.
 */
export declare function sessionSocketOptions(session: string, path?: string): Partial<ManagerOptions & SocketOptions>;
/**
 * The URL to hand `io()` for a FoundryVTT base URL: its origin only.
 *
 * socket.io-client reads the URL's pathname as the **namespace**, not the
 * transport path, so `io('https://host/foundry')` would join namespace
 * `/foundry` instead of reaching a server behind a `routePrefix` (#231). The
 * prefix belongs in the `path` option ({@link sessionSocketOptions}); the
 * HTTP `/join` calls keep the full base URL.
 */
export declare function socketOrigin(baseUrl: string): string;
/**
 * Authenticates with FoundryVTT using the proven 4-step flow.
 *
 * @param socketPath Socket.IO endpoint for the user-resolution handshake;
 *   defaults to `/socket.io/` (see {@link sessionSocketOptions}).
 * @returns Session cookie and resolved user document _id
 */
export declare function authenticateFoundry(baseUrl: string, user: string, password: string, socketPath?: string): Promise<{
    session: string;
    userId: string;
}>;
//# sourceMappingURL=auth.d.ts.map