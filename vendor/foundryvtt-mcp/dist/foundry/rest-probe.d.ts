/**
 * REST-module probe, kept free of config and logger imports so that
 * `scripts/` entrypoints (setup wizard, API diagnostics) can import it before
 * any `.env` exists: importing `client.ts` resolves the whole config through
 * `utils/logger.ts` and exits when `FOUNDRY_URL` is unset (#255).
 */
/**
 * Proves the REST module is installed and accepts `FOUNDRY_API_KEY` (#230).
 *
 * `/api/status` cannot do this: Foundry core serves it unauthenticated, so a
 * 200 there says nothing about the module or the key. `/api/world` is a module
 * route that requires the key, and the body is validated rather than trusting
 * any 2xx. Shared by `FoundryClient.connect()`, the diagnostics probe and the
 * `scripts/` setup wizard and API diagnostics (#255).
 *
 * @param get - performs the GET (with the `x-api-key` header applied)
 * @returns the validated `/api/world` body
 * @throws Error naming the key on HTTP 401/403, or the missing module on any
 *   other HTTP status or a non-object body. A transport failure (no HTTP
 *   response) is rethrown unchanged so "server unreachable" stays visible.
 */
export declare function probeRestModule(get: (url: string) => Promise<{
    data: unknown;
}>): Promise<Record<string, unknown>>;
//# sourceMappingURL=rest-probe.d.ts.map