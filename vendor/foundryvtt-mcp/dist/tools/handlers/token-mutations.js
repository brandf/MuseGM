/**
 * @fileoverview Token manipulation mutation tool handlers (FR-019)
 *
 * Provides GM-gated token-control tools that operate on tokens placed on
 * scenes: moving a token to new coordinates, and applying/removing a status
 * condition (ActiveEffect) on the token's actor. All are WRITE operations —
 * they require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO connection
 * (mutations use the core `modifyDocument` protocol), and the connected user
 * needs GM/owner permission.
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { withToolError } from './utils.js';
/**
 * Moves a token to x/y coordinates on its scene (FR-019).
 *
 * The token is resolved from the cached worldData; `sceneId` is optional and
 * only scopes the lookup (the parent scene is derived from the located token).
 */
export async function handleMoveToken(args, foundryClient) {
    const { tokenId, x, y, sceneId } = args;
    if (!tokenId || typeof tokenId !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
    }
    if (typeof x !== 'number' ||
        !Number.isFinite(x) ||
        typeof y !== 'number' ||
        !Number.isFinite(y)) {
        throw new McpError(ErrorCode.InvalidParams, 'x and y are required and must be finite numbers');
    }
    const located = foundryClient.findToken(tokenId, sceneId);
    if (!located) {
        throw new McpError(ErrorCode.InvalidRequest, `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`);
    }
    return withToolError('move token', async () => {
        const tokenName = located.token.name ?? tokenId;
        await foundryClient.moveToken(located.scene._id, tokenId, x, y);
        return {
            content: [
                {
                    type: 'text',
                    text: `🚶 **Token Moved**
**Token:** ${tokenName} (${tokenId})
**Scene:** ${located.scene.name} (${located.scene._id})
**Position:** (${x}, ${y})`,
                },
            ],
        };
    });
}
/**
 * Applies or removes a status condition (ActiveEffect) on a token's actor
 * (FR-019).
 *
 * `active` defaults to `true` (apply). Mirrors `Actor#toggleStatusEffect`:
 * the effect is matched by its `statuses` array, so re-applying an already
 * present condition (or removing an absent one) is a no-op. Linked actors
 * resolve to `Actor.<id>`; unlinked tokens target their synthetic actor at
 * `Scene.<sid>.Token.<tid>.Actor.<aid>`.
 */
export async function handleApplyStatusEffect(args, foundryClient) {
    const { tokenId, statusId, sceneId } = args;
    const active = args.active ?? true;
    if (!tokenId || typeof tokenId !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
    }
    if (!statusId || typeof statusId !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'statusId is required and must be a string');
    }
    const located = foundryClient.findToken(tokenId, sceneId);
    if (!located) {
        throw new McpError(ErrorCode.InvalidRequest, `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`);
    }
    const token = located.token;
    const actorId = token.actorId;
    if (!actorId) {
        throw new McpError(ErrorCode.InvalidRequest, `Token ${tokenId} has no associated actor; cannot apply status effects.`);
    }
    // Linked tokens share the world actor; unlinked tokens own a synthetic actor
    // (the per-token delta) that must be addressed through the Scene→Token path.
    const linked = token.actorLink === true;
    const parentActorUuid = linked
        ? `Actor.${actorId}`
        : `Scene.${located.scene._id}.Token.${tokenId}.Actor.${actorId}`;
    // Find an existing effect carrying this status (matches toggleStatusEffect).
    const effects = linked
        ? (foundryClient.getRawActor(actorId)?.effects ?? [])
        : (token.delta?.effects ?? []);
    const existing = effects.find((e) => e.statuses?.includes(statusId));
    return withToolError('apply status effect', async () => {
        if (active) {
            if (existing) {
                return statusResult(`Status effect '${statusId}' is already active on ${token.name ?? tokenId}.`, tokenId, located.scene, statusId, true);
            }
            const effect = await foundryClient.createActorStatusEffect(parentActorUuid, statusId);
            return statusResult(`Applied status effect '${statusId}' (effect ${effect._id}).`, tokenId, located.scene, statusId, true);
        }
        if (!existing) {
            return statusResult(`Status effect '${statusId}' is not active on ${token.name ?? tokenId}; nothing to remove.`, tokenId, located.scene, statusId, false);
        }
        await foundryClient.deleteActorEffect(parentActorUuid, existing._id);
        return statusResult(`Removed status effect '${statusId}' (effect ${existing._id}).`, tokenId, located.scene, statusId, false);
    });
}
/** Builds the MCP text result for a status-effect mutation. */
function statusResult(summary, tokenId, scene, statusId, active) {
    return {
        content: [
            {
                type: 'text',
                text: `${active ? '✨' : '🧹'} **Status Effect ${active ? 'Applied' : 'Removed'}**
**Token:** ${tokenId}
**Scene:** ${scene.name} (${scene._id})
**Status:** ${statusId}
${summary}`,
            },
        ],
    };
}
//# sourceMappingURL=token-mutations.js.map