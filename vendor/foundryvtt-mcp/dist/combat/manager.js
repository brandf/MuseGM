import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
export class CombatManager extends EventEmitter {
    currentCombat = null;
    combatHistory = [];
    turnTimer;
    TURN_WARNING_TIME = 30000; // 30 seconds
    constructor(_foundryClient) {
        super();
        this.setupEventHandlers();
    }
    setupEventHandlers() {
        this.on('combat_start', this.handleCombatStart.bind(this));
        this.on('turn_start', this.handleTurnStart.bind(this));
        this.on('turn_end', this.handleTurnEnd.bind(this));
        this.on('round_end', this.handleRoundEnd.bind(this));
    }
    /**
     * Destroy the combat manager and release resources
     */
    destroy() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = undefined;
        }
        this.removeAllListeners();
        this.currentCombat = null;
        this.combatHistory = [];
        logger.info('Combat manager destroyed');
    }
    // Public API Methods
    getCurrentCombat() {
        return this.currentCombat;
    }
    getCombatHistory(limit = 50) {
        return this.combatHistory.slice(-limit);
    }
    async startCombat(combatants) {
        logger.info('Starting new combat encounter');
        const combat = {
            id: this.generateCombatId(),
            round: 1,
            turn: 0,
            active: true,
            started: false,
            combatants: await this.initializeCombatants(combatants),
            turnStartTime: new Date(),
            roundStartTime: new Date(),
        };
        // Sort by initiative
        combat.combatants.sort((a, b) => (b.initiative || 0) - (a.initiative || 0));
        this.currentCombat = combat;
        this.emitCombatEvent('combat_start', combat);
        return combat;
    }
    async rollInitiative(combatantId) {
        if (!this.currentCombat) {
            throw new Error('No active combat');
        }
        const results = {};
        const combatants = combatantId
            ? this.currentCombat.combatants.filter((c) => c.id === combatantId)
            : this.currentCombat.combatants;
        for (const combatant of combatants) {
            // Roll 1d20 + initiative modifier (simplified)
            const roll = Math.floor(Math.random() * 20) + 1;
            const modifier = this.getInitiativeModifier(combatant);
            const total = roll + modifier;
            combatant.initiative = total;
            results[combatant.name] = total;
            logger.debug(`${combatant.name} rolled initiative: ${total} (${roll} + ${modifier})`);
        }
        // Re-sort combatants by initiative
        this.currentCombat.combatants.sort((a, b) => (b.initiative || 0) - (a.initiative || 0));
        this.emitCombatEvent('initiative_changed', this.currentCombat, results);
        return results;
    }
    async nextTurn() {
        if (!this.currentCombat || !this.currentCombat.active) {
            throw new Error('No active combat');
        }
        // End current turn
        if (this.currentCombat.currentCombatant) {
            this.emitCombatEvent('turn_end', this.currentCombat);
        }
        // Clear turn timer
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
        }
        // Advance to next combatant
        this.currentCombat.turn++;
        // Check if we need to start a new round
        if (this.currentCombat.turn >= this.currentCombat.combatants.length) {
            this.currentCombat.turn = 0;
            this.currentCombat.round++;
            this.emitCombatEvent('round_end', this.currentCombat);
            // Reset turn actions for all combatants
            this.currentCombat.combatants.forEach((c) => {
                c.turnTaken = false;
                c.actions = {
                    action: false,
                    bonus: false,
                    movement: 0,
                    reaction: false,
                };
            });
        }
        // Set current combatant
        const combatant = this.currentCombat.combatants[this.currentCombat.turn];
        if (combatant) {
            this.currentCombat.currentCombatant = combatant;
        }
        this.currentCombat.turnStartTime = new Date();
        if (!this.currentCombat.started) {
            this.currentCombat.started = true;
        }
        this.emitCombatEvent('turn_start', this.currentCombat);
        return this.currentCombat.currentCombatant || null;
    }
    async applyDamage(combatantId, damage, damageType) {
        if (!this.currentCombat) {
            throw new Error('No active combat');
        }
        const combatant = this.currentCombat.combatants.find((c) => c.id === combatantId);
        if (!combatant) {
            throw new Error(`Combatant ${combatantId} not found`);
        }
        // Apply damage to temp HP first, then regular HP
        let remainingDamage = damage;
        if (combatant.hp.temp && combatant.hp.temp > 0) {
            const tempDamage = Math.min(remainingDamage, combatant.hp.temp);
            combatant.hp.temp -= tempDamage;
            remainingDamage -= tempDamage;
        }
        combatant.hp.current = Math.max(0, combatant.hp.current - remainingDamage);
        // Check if combatant is defeated
        if (combatant.hp.current === 0) {
            combatant.defeated = true;
        }
        this.emitCombatEvent('damage_dealt', this.currentCombat, {
            combatantId,
            damage,
            damageType,
            newHP: combatant.hp.current,
            defeated: combatant.defeated,
        });
        logger.info(`${combatant.name} took ${damage} ${damageType || 'damage'}, HP: ${combatant.hp.current}/${combatant.hp.max}`);
        return combatant;
    }
    async healCombatant(combatantId, healing) {
        if (!this.currentCombat) {
            throw new Error('No active combat');
        }
        const combatant = this.currentCombat.combatants.find((c) => c.id === combatantId);
        if (!combatant) {
            throw new Error(`Combatant ${combatantId} not found`);
        }
        combatant.hp.current = Math.min(combatant.hp.max, combatant.hp.current + healing);
        if (combatant.hp.current > 0) {
            combatant.defeated = false;
        }
        logger.info(`${combatant.name} healed for ${healing}, HP: ${combatant.hp.current}/${combatant.hp.max}`);
        return combatant;
    }
    async applyCondition(combatantId, condition, duration) {
        if (!this.currentCombat) {
            throw new Error('No active combat');
        }
        const combatant = this.currentCombat.combatants.find((c) => c.id === combatantId);
        if (!combatant) {
            throw new Error(`Combatant ${combatantId} not found`);
        }
        if (!combatant.conditions.includes(condition)) {
            combatant.conditions.push(condition);
            this.emitCombatEvent('condition_applied', this.currentCombat, {
                combatantId,
                condition,
                duration,
            });
            logger.info(`Applied ${condition} to ${combatant.name}`);
        }
        return combatant;
    }
    async removeCondition(combatantId, condition) {
        if (!this.currentCombat) {
            throw new Error('No active combat');
        }
        const combatant = this.currentCombat.combatants.find((c) => c.id === combatantId);
        if (!combatant) {
            throw new Error(`Combatant ${combatantId} not found`);
        }
        const index = combatant.conditions.indexOf(condition);
        if (index > -1) {
            combatant.conditions.splice(index, 1);
            logger.info(`Removed ${condition} from ${combatant.name}`);
        }
        return combatant;
    }
    async endCombat() {
        if (!this.currentCombat) {
            throw new Error('No active combat');
        }
        this.currentCombat.active = false;
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
        }
        const endedCombat = { ...this.currentCombat };
        this.emitCombatEvent('combat_end', endedCombat);
        logger.info('Combat ended');
        this.currentCombat = null;
        return endedCombat;
    }
    // Event Handlers
    handleCombatStart(event) {
        logger.info(`Combat started with ${event.combat.combatants.length} combatants`);
    }
    handleTurnStart(event) {
        const combatant = event.combat.currentCombatant;
        if (combatant) {
            logger.info(`Turn ${event.combat.turn + 1}, Round ${event.combat.round}: ${combatant.name}'s turn`);
            // Set turn timer
            this.turnTimer = setTimeout(() => {
                this.emit('turn_warning', combatant);
            }, this.TURN_WARNING_TIME);
        }
    }
    handleTurnEnd(event) {
        const combatant = event.combat.currentCombatant;
        if (combatant) {
            combatant.turnTaken = true;
            logger.debug(`${combatant.name} ended their turn`);
        }
    }
    handleRoundEnd(event) {
        logger.info(`Round ${event.combat.round - 1} ended, starting Round ${event.combat.round}`);
    }
    // Helper Methods
    async initializeCombatants(combatantData) {
        const combatants = [];
        for (const data of combatantData) {
            const combatant = {
                id: data.id || this.generateCombatantId(),
                name: data.name || 'Unknown',
                initiative: data.initiative || 0,
                hp: data.hp || { current: 1, max: 1 },
                ac: data.ac || 10,
                conditions: data.conditions || [],
                defeated: data.defeated || false,
                hidden: data.hidden || false,
                actorId: data.actorId || '',
                tokenId: data.tokenId || '',
                turnTaken: false,
                actions: {
                    action: false,
                    bonus: false,
                    movement: 0,
                    reaction: false,
                },
            };
            combatants.push(combatant);
        }
        return combatants;
    }
    getInitiativeModifier(_combatant) {
        // Simplified initiative modifier calculation
        // In a real implementation, this would pull from the actual character sheet
        return Math.floor(Math.random() * 6) - 1; // -1 to +4
    }
    generateCombatId() {
        return `combat_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }
    generateCombatantId() {
        return `combatant_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }
    emitCombatEvent(type, combat, data) {
        const event = {
            type,
            timestamp: new Date(),
            combat: { ...combat }, // Deep copy to prevent mutations
            data,
        };
        this.combatHistory.push(event);
        // Keep history manageable
        if (this.combatHistory.length > 1000) {
            this.combatHistory = this.combatHistory.slice(-500);
        }
        this.emit(type, event);
        this.emit('combat_event', event);
    }
    // Analysis Methods
    getCombatStatistics() {
        if (!this.currentCombat) {
            return null;
        }
        const stats = {
            totalRounds: this.currentCombat.round,
            totalTurns: this.currentCombat.round * this.currentCombat.combatants.length + this.currentCombat.turn,
            averageTurnTime: this.calculateAverageTurnTime(),
            combatants: this.currentCombat.combatants.map((c) => ({
                name: c.name,
                initiative: c.initiative || 0,
                hp: { current: c.hp.current, max: c.hp.max },
                status: c.conditions,
            })),
            activeEffects: this.currentCombat.combatants.reduce((acc, c) => acc + c.conditions.length, 0),
        };
        return stats;
    }
    calculateAverageTurnTime() {
        const turnEvents = this.combatHistory.filter((e) => e.type === 'turn_start');
        if (turnEvents.length < 2) {
            return 0;
        }
        let totalTime = 0;
        for (let i = 1; i < turnEvents.length; i++) {
            const currentEvent = turnEvents[i];
            const previousEvent = turnEvents[i - 1];
            if (currentEvent && previousEvent) {
                totalTime += currentEvent.timestamp.getTime() - previousEvent.timestamp.getTime();
            }
        }
        return Math.round(totalTime / (turnEvents.length - 1) / 1000); // seconds
    }
    suggestTacticalActions(combatantId) {
        if (!this.currentCombat) {
            return ['No active combat'];
        }
        const combatant = this.currentCombat.combatants.find((c) => c.id === combatantId);
        if (!combatant) {
            return ['Combatant not found'];
        }
        const suggestions = [];
        // HP-based suggestions
        const hpPercent = (combatant.hp.current / combatant.hp.max) * 100;
        if (hpPercent < 25) {
            suggestions.push('Consider healing or retreating - HP critically low');
            suggestions.push('Use defensive actions like Dodge or Shield');
        }
        else if (hpPercent < 50) {
            suggestions.push('Monitor HP carefully - consider healing');
        }
        // Condition-based suggestions
        if (combatant.conditions.includes('poisoned')) {
            suggestions.push('Remove poison condition if possible');
        }
        if (combatant.conditions.includes('prone')) {
            suggestions.push('Use movement to stand up from prone');
        }
        if (combatant.conditions.includes('grappled')) {
            suggestions.push('Attempt to escape grapple with Athletics or Acrobatics');
        }
        // Action economy suggestions
        if (!combatant.actions.action) {
            suggestions.push('Use your Action for Attack, Cast a Spell, or other actions');
        }
        if (!combatant.actions.bonus) {
            suggestions.push('Check for available Bonus Actions');
        }
        // Enemy analysis
        const enemies = this.currentCombat.combatants.filter((c) => c.id !== combatantId && !c.defeated);
        const lowHpEnemies = enemies.filter((e) => e.hp.current / e.hp.max < 0.3);
        if (lowHpEnemies.length > 0) {
            suggestions.push(`Focus fire on low HP enemies: ${lowHpEnemies.map((e) => e.name).join(', ')}`);
        }
        if (suggestions.length === 0) {
            suggestions.push('Assess battlefield and choose optimal action');
        }
        return suggestions;
    }
}
//# sourceMappingURL=manager.js.map