/**
 * @fileoverview Tool definitions for FoundryVTT MCP Server
 *
 * This module contains all tool schema definitions organized by category.
 * Tools are separated into logical groups for better maintainability.
 */
/**
 * Canonical `roll_dice` description.
 *
 * Exported so `RollDiceTool` (`src/tools/handlers/dice.ts`) can reuse the exact
 * same string instead of keeping a second copy that silently drifts: the
 * registry class is what *executes* the tool while `getAllTools()` is what is
 * *listed*, so a divergence would be invisible.
 */
export declare const ROLL_DICE_DESCRIPTION = "Roll dice and return the total with a per-term breakdown. Dice terms and whole numbers joined by + or -, with whitespace allowed anywhere (\"1d20+5\", \"1d20 + 5\", \"1d20+5+3\", \"2d6 + 1d4\", \"3d6\"; a count-less \"d20\" means one die), always work and every term counts towards the total - that is the portable grammar, safe on either transport. Multiplication and Foundry modifier syntax such as \"4d6kh3\" or \"1d20r1\" are rejected on both transports, with an error naming the offending character and its position, never dropped from the total in silence. Parentheses are the one difference: with FOUNDRY_API_KEY set the formula goes to FoundryVTT's own Roll engine, which evaluates them, while the default Socket.IO transport rolls locally and rejects them by name - and a REST roll that cannot reach the server falls back to that same local roller, so a parenthesised formula can still fail there. The result's Source line says which roller produced it: \"FoundryVTT server\" or the local roller. Prefer the expanded form when it matters. Use when: the user asks for a check, save, attack, damage, or any random result.";
/**
 * Dice rolling tool definitions
 */
export declare const diceTools: {
    name: string;
    description: string;
    inputSchema: {
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
}[];
/**
 * Actor management tool definitions
 */
export declare const actorTools: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            type: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
                default: number;
            };
            actorId?: never;
        };
        required?: never;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            actorId: {
                type: string;
                description: string;
            };
            query?: never;
            type?: never;
            limit?: never;
        };
        required: string[];
    };
})[];
/**
 * Actor attribute mutation tool definitions (#143)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active
 * Socket.IO connection (mutations use the core `modifyDocument` protocol).
 */
export declare const actorMutationTools: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            actorId: {
                type: string;
                description: string;
            };
            patch: {
                type: string;
                description: string;
                additionalProperties: {
                    type: string[];
                };
            };
        };
        required: string[];
    };
}[];
/**
 * Item management tool definitions
 */
export declare const itemTools: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            type: {
                type: string;
                description: string;
            };
            rarity: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
                default: number;
            };
        };
    };
}[];
/**
 * Compendium search tool definitions (#144)
 */
export declare const compendiumTools: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            filters: {
                type: string;
                description: string;
                properties: {
                    compendiumId: {
                        type: string;
                        description: string;
                    };
                    packType: {
                        type: string;
                        description: string;
                    };
                    itemType: {
                        type: string;
                        description: string;
                    };
                    spellLevel: {
                        type: string;
                        description: string;
                    };
                    source: {
                        type: string;
                        description: string;
                    };
                };
            };
            limit: {
                type: string;
                description: string;
                default: number;
            };
            cursor: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}[];
/**
 * Actor item mutation tool definitions (WRITE — require FOUNDRY_WRITE_ENABLED
 * and an active Socket.IO connection; mutations use `modifyDocument`)
 *
 * The canonical mutation target is the D&D 5e v4+ activity schema. Item
 * `system` patches honour JSON-merge-patch semantics on nested paths.
 */
export declare const itemMutationTools: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            actorId: {
                type: string;
                description: string;
            };
            source: {
                type: string;
                description: string;
                properties: {
                    type: {
                        type: string;
                        enum: string[];
                        description: string;
                    };
                    compendiumId: {
                        type: string;
                        description: string;
                    };
                    itemId: {
                        type: string;
                        description: string;
                    };
                    item: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
            itemId?: never;
            patch?: never;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            actorId: {
                type: string;
                description: string;
            };
            itemId: {
                type: string;
                description: string;
            };
            patch: {
                type: string;
                description: string;
            };
            source?: never;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            actorId: {
                type: string;
                description: string;
            };
            itemId: {
                type: string;
                description: string;
            };
            source?: never;
            patch?: never;
        };
        required: string[];
    };
})[];
/**
 * Scene management tool definitions
 */
export declare const sceneTools: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            sceneId: {
                type: string;
                description: string;
            };
        };
    };
}[];
/**
 * Content generation tool definitions
 */
export declare const generationTools: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            level: {
                type: string;
                description: string;
                minimum: number;
                maximum: number;
                default: number;
            };
            race: {
                type: string;
                description: string;
            };
            class: {
                type: string;
                description: string;
            };
            challengeRating?: never;
            treasureType?: never;
            query?: never;
            system?: never;
        };
        required?: never;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            challengeRating: {
                type: string;
                description: string;
                minimum: number;
                maximum: number;
            };
            treasureType: {
                type: string;
                description: string;
            };
            level?: never;
            race?: never;
            class?: never;
            query?: never;
            system?: never;
        };
        required?: never;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            system: {
                type: string;
                description: string;
            };
            level?: never;
            race?: never;
            class?: never;
            challengeRating?: never;
            treasureType?: never;
        };
        required: string[];
    };
})[];
/**
 * Diagnostics and logging tool definitions
 */
export declare const diagnosticsTools: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            limit: {
                type: string;
                description: string;
                default: number;
                minimum: number;
                maximum: number;
            };
            level: {
                type: string;
                description: string;
                enum: string[];
            };
            since: {
                type: string;
                description: string;
            };
            query?: never;
            category?: never;
        };
        required?: never;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            level: {
                type: string;
                description: string;
                enum: string[];
            };
            limit: {
                type: string;
                description: string;
                default: number;
                minimum?: never;
                maximum?: never;
            };
            since?: never;
            category?: never;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            limit?: never;
            level?: never;
            since?: never;
            query?: never;
            category?: never;
        };
        required?: never;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            category: {
                type: string;
                description: string;
            };
            limit?: never;
            level?: never;
            since?: never;
            query?: never;
        };
        required?: never;
    };
})[];
/**
 * Combat tool definitions
 */
export declare const combatTools: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {};
    };
}[];
/**
 * Combat control mutation tool definitions (FR-018)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). All operate on
 * the *active* combat; the connected user needs GM/owner permission.
 */
export declare const combatMutationTools: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            skipDefeated: {
                type: string;
                description: string;
            };
            combatantId?: never;
            initiative?: never;
            combatId?: never;
            tokenIds?: never;
            sceneId?: never;
        };
        required?: never;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            skipDefeated?: never;
            combatantId?: never;
            initiative?: never;
            combatId?: never;
            tokenIds?: never;
            sceneId?: never;
        };
        required?: never;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            combatantId: {
                type: string;
                description: string;
            };
            initiative: {
                type: string;
                description: string;
            };
            combatId: {
                type: string;
                description: string;
            };
            skipDefeated?: never;
            tokenIds?: never;
            sceneId?: never;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            tokenIds: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            sceneId: {
                type: string;
                description: string;
            };
            skipDefeated?: never;
            combatantId?: never;
            initiative?: never;
            combatId?: never;
        };
        required?: never;
    };
})[];
/**
 * Token manipulation mutation tool definitions (FR-019)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). The connected
 * user needs GM/owner permission.
 */
export declare const tokenMutationTools: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            tokenId: {
                type: string;
                description: string;
            };
            x: {
                type: string;
                description: string;
            };
            y: {
                type: string;
                description: string;
            };
            sceneId: {
                type: string;
                description: string;
            };
            statusId?: never;
            active?: never;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            tokenId: {
                type: string;
                description: string;
            };
            statusId: {
                type: string;
                description: string;
            };
            active: {
                type: string;
                description: string;
                default: boolean;
            };
            sceneId: {
                type: string;
                description: string;
            };
            x?: never;
            y?: never;
        };
        required: string[];
    };
})[];
/**
 * Chat message tool definitions
 */
export declare const chatTools: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            limit: {
                type: string;
                description: string;
                default: number;
                minimum: number;
                maximum: number;
            };
        };
    };
}[];
/**
 * User tool definitions
 */
export declare const userTools: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {};
    };
}[];
/**
 * Journal tool definitions
 */
export declare const journalTools: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
                default: number;
            };
            journalId?: never;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            journalId: {
                type: string;
                description: string;
            };
            query?: never;
            limit?: never;
        };
        required: string[];
    };
})[];
/**
 * Journal mutation tool definitions (WRITE)
 */
export declare const journalMutationTools: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            name: {
                type: string;
                description: string;
            };
            pages: {
                type: string;
                description: string;
                items: {
                    type: string;
                    properties: {
                        name: {
                            type: string;
                            description: string;
                        };
                        content: {
                            type: string;
                            description: string;
                        };
                    };
                    required: string[];
                };
                minItems: number;
            };
            folder: {
                type: string;
                description: string;
            };
            visibility: {
                type: string;
                enum: string[];
                description: string;
            };
        };
        required: string[];
    };
}[];
/**
 * World-level tool definitions
 */
export declare const worldTools: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
                default: number;
            };
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query?: never;
            limit?: never;
        };
        required?: never;
    };
})[];
/**
 * Get all tool definitions combined
 */
export declare function getAllTools(): {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {};
    };
}[];
/**
 * Get modernized tool definitions from registry (when available)
 */
export declare function getModernizedTools(): Promise<{
    name: string;
    description: string;
    inputSchema: object;
}[]>;
//# sourceMappingURL=definitions.d.ts.map