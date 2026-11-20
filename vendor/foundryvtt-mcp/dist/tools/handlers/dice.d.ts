/**
 * @fileoverview Dice rolling tool handlers
 *
 * Handles dice rolling operations using FoundryVTT's dice system
 * or fallback mechanisms when the API is unavailable.
 */
import type { FoundryClient } from '../../foundry/client.js';
import { BaseTool, type ToolContext, type ToolResult } from '../base.js';
/**
 * Dice rolling tool implementation
 */
export declare class RollDiceTool extends BaseTool {
    readonly name = "roll_dice";
    readonly description = "Roll dice and return the total with a per-term breakdown. Dice terms and whole numbers joined by + or -, with whitespace allowed anywhere (\"1d20+5\", \"1d20 + 5\", \"1d20+5+3\", \"2d6 + 1d4\", \"3d6\"; a count-less \"d20\" means one die), always work and every term counts towards the total - that is the portable grammar, safe on either transport. Multiplication and Foundry modifier syntax such as \"4d6kh3\" or \"1d20r1\" are rejected on both transports, with an error naming the offending character and its position, never dropped from the total in silence. Parentheses are the one difference: with FOUNDRY_API_KEY set the formula goes to FoundryVTT's own Roll engine, which evaluates them, while the default Socket.IO transport rolls locally and rejects them by name - and a REST roll that cannot reach the server falls back to that same local roller, so a parenthesised formula can still fail there. The result's Source line says which roller produced it: \"FoundryVTT server\" or the local roller. Prefer the expanded form when it matters. Use when: the user asks for a check, save, attack, damage, or any random result.";
    readonly inputSchema: {
        type: string;
        properties: {
            formula: {
                type: string;
                description: string;
            };
            reason: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    protected executeValidated(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
/**
 * Legacy function for backward compatibility
 * @deprecated Use RollDiceTool class instead
 */
export declare function handleRollDice(args: {
    formula: string;
    reason?: string;
}, foundryClient: FoundryClient): Promise<ToolResult>;
//# sourceMappingURL=dice.d.ts.map