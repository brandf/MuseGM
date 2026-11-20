import { EventEmitter } from 'node:events';
import type { FoundryClient } from '../foundry/client.js';
export interface CharacterAdvancement {
    actorId: string;
    fromLevel: number;
    toLevel: number;
    hitPointsGained: number;
    abilityScoreImprovements: Array<{
        ability: string;
        increase: number;
    }>;
    newSpellsLearned: string[];
    newFeatures: string[];
    skillProficiencies: string[];
    timestamp: Date;
}
export interface EquipmentTransaction {
    actorId: string;
    action: 'add' | 'remove' | 'equip' | 'unequip' | 'transfer';
    itemId: string;
    itemName: string;
    quantity?: number;
    targetActorId?: string;
    timestamp: Date;
}
export interface ResourceManagement {
    actorId: string;
    resource: string;
    maxValue: number;
    currentValue: number;
    resetType: 'short_rest' | 'long_rest' | 'daily' | 'manual';
    lastReset?: Date;
}
export interface PartyComposition {
    actors: string[];
    averageLevel: number;
    encounterRating: string;
    roleBalance: {
        tank: number;
        healer: number;
        damage: number;
        support: number;
        control: number;
    };
    recommendations: string[];
}
export declare class CharacterManager extends EventEmitter {
    private foundryClient;
    private advancementHistory;
    private equipmentHistory;
    private resourceTracking;
    constructor(foundryClient: FoundryClient);
    levelUpCharacter(actorId: string, options?: {
        hitPointMethod?: 'roll' | 'average' | 'max';
        abilityScoreImprovements?: Array<{
            ability: string;
            increase: number;
        }>;
        newSpells?: string[];
        newFeatures?: string[];
        newSkills?: string[];
    }): Promise<CharacterAdvancement>;
    calculateExperienceRequired(currentLevel: number, targetLevel?: number): Promise<{
        current: number;
        required: number;
        remaining: number;
        nextMilestone: number;
    }>;
    addItemToCharacter(actorId: string, itemData: {
        name: string;
        type: string;
        quantity?: number;
        properties?: Record<string, unknown>;
        equipped?: boolean;
    }): Promise<EquipmentTransaction>;
    equipItem(actorId: string, itemId: string): Promise<EquipmentTransaction>;
    transferItem(fromActorId: string, toActorId: string, itemId: string, quantity?: number): Promise<EquipmentTransaction>;
    trackResource(actorId: string, resourceName: string, config: {
        maxValue: number;
        currentValue?: number;
        resetType: 'short_rest' | 'long_rest' | 'daily' | 'manual';
    }): Promise<ResourceManagement>;
    useResource(actorId: string, resourceName: string, amount?: number): Promise<ResourceManagement | null>;
    restoreResources(actorId: string, restType: 'short_rest' | 'long_rest'): Promise<ResourceManagement[]>;
    private calculateHitPointGain;
    private suggestAbilityImprovements;
    private determineNewSpells;
    private determineNewFeatures;
    private determineNewSkills;
    private generateItemId;
}
//# sourceMappingURL=manager.d.ts.map