/**
 * @fileoverview Dice rolling tool handlers
 *
 * Handles dice rolling operations using FoundryVTT's dice system
 * or fallback mechanisms when the API is unavailable.
 */
import { logger } from '../../utils/logger.js';
// import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseTool } from '../base.js';
import { ROLL_DICE_DESCRIPTION } from '../definitions.js';
/**
 * Dice rolling tool implementation
 */
export class RollDiceTool extends BaseTool {
    name = 'roll_dice';
    description = ROLL_DICE_DESCRIPTION;
    inputSchema = {
        type: 'object',
        properties: {
            formula: {
                type: 'string',
                description: 'Dice formula (e.g., "1d20+5", "3d6")',
            },
            reason: {
                type: 'string',
                description: 'Optional reason for the roll',
            },
        },
        required: ['formula'],
    };
    async executeValidated(args, context) {
        const { formula, reason } = args;
        logger.info(`Rolling dice: ${formula}${reason ? ` (${reason})` : ''}`);
        const result = await context.foundryClient.rollDice(formula, reason);
        return this.createTextResponse(`🎲 **Dice Roll Result**
**Formula:** ${result.formula}
**Total:** ${result.total}
**Breakdown:** ${result.breakdown}
${result.reason ? `**Reason:** ${result.reason}` : ''}
**Source:** ${result.source === 'server' ? 'FoundryVTT server' : 'local roller (this MCP server, not FoundryVTT)'}
**Timestamp:** ${result.timestamp}`);
    }
}
/**
 * Legacy function for backward compatibility
 * @deprecated Use RollDiceTool class instead
 */
export async function handleRollDice(args, foundryClient) {
    const tool = new RollDiceTool();
    const context = {
        foundryClient,
    };
    return tool.execute(args, context);
}
//# sourceMappingURL=dice.js.map