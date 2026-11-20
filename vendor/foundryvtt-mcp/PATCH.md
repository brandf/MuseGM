# Local patch (2026-11-19)

Published `foundryvtt-mcp` 1.5.5 fails to log in to Foundry 14.370:
POST /join returns HTTP 400 `{"error":"The request could not be processed."}`.

Root cause: Foundry 14.370 requires an `Origin` header on POST /join
(CSRF check). Axios (used by the MCP) does not send Origin for
non-browser requests, so the MCP's POST is rejected. Isolated by testing
POST /join variants headlessly: Origin alone -> 200 LoginSuccess;
Referer alone -> 400; User-Agent alone -> 400; no extra headers -> 400.

Also confirmed on 14.370: the server reads `userId` (camelCase), not
`userid` — userid-only returns 401 JOIN.ErrorUserDoesNotExist. The MCP
sends both spellings, so that part is fine.

Fix: `dist/foundry/auth.js`, in `authenticateFoundry`'s POST /join headers,
added `Origin: baseUrl`.

Verified 2026-11-19: patched server logs "FoundryVTT authentication
successful" and "Connected to FoundryVTT via Socket.IO {actors:31,
scenes:4, items:13}" and "FoundryVTT MCP Server started successfully".

Upstream: this should be reported to laurigates/foundryvtt-mcp — the fix
is one header in the POST /join call.
