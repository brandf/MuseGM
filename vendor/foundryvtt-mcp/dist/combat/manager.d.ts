import { EventEmitter } from 'node:events';
import type { FoundryClient } from '../foundry/client.js';
export interface CombatState {
    id: string;
    round: number;
    turn: number;
    active: boolean;
    started: boolean;
    scene?: string;
    combatants: CombatantState[];
    currentCombatant?: CombatantState;
    turnStartTime?: Date;
    roundStartTime?: Date;
}
export interface CombatantState {
    id: string;
    name: string;
    initiative?: number;
    hp: {
        current: number;
        max: number;
        temp?: number;
    };
    ac?: number;
    conditions: string[];
    defeated: boolean;
    hidden: boolean;
    actorId?: string;
    tokenId?: string;
    turnTaken: boolean;
    actions: {
        action: boolean;
        bonus: boolean;
        movement: number;
        reaction: boolean;
    };
}
export interface CombatEvent {
    type: 'combat_start' | 'combat_end' | 'turn_start' | 'turn_end' | 'round_start' | 'round_end' | 'damage_dealt' | 'condition_applied' | 'initiative_changed';
    timestamp: Date;
    combat: CombatState;
    data?: unknown;
}
export declare class CombatManager extends EventEmitter {
    private currentCombat;
    private combatHistory;
    private turnTimer;
    private readonly TURN_WARNING_TIME;
    constructor(_foundryClient: FoundryClient);
    private setupEventHandlers;
    /**
     * Destroy the combat manager and release resources
     */
    destroy(): void;
    getCurrentCombat(): CombatState | null;
    getCombatHistory(limit?: number): CombatEvent[];
    startCombat(combatants: Partial<CombatantState>[]): Promise<CombatState>;
    rollInitiative(combatantId?: string): Promise<{
        [key: string]: number;
    }>;
    nextTurn(): Promise<CombatantState | null>;
    applyDamage(combatantId: string, damage: number, damageType?: string): Promise<CombatantState>;
    healCombatant(combatantId: string, healing: number): Promise<CombatantState>;
    applyCondition(combatantId: string, condition: string, duration?: number): Promise<CombatantState>;
    removeCondition(combatantId: string, condition: string): Promise<CombatantState>;
    endCombat(): Promise<CombatState>;
    private handleCombatStart;
    private handleTurnStart;
    private handleTurnEnd;
    private handleRoundEnd;
    private initializeCombatants;
    private getInitiativeModifier;
    private generateCombatId;
    private generateCombatantId;
    private emitCombatEvent;
    getCombatStatistics(): {
        totalRounds: number;
        totalTurns: number;
        averageTurnTime: number;
        combatants: Array<{
            name: string;
            initiative: number;
            hp: {
                current: number;
                max: number;
            };
            status: string[];
        }>;
    } | null;
    private calculateAverageTurnTime;
    suggestTacticalActions(combatantId: string): string[];
}
//# sourceMappingURL=manager.d.ts.map