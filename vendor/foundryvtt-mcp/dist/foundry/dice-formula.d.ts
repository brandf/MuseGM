/**
 * @fileoverview Dice formula parsing and evaluation for the local roller (#219).
 *
 * The local roller used to scan a formula with `/(\d+)d(\d+)([+-]\d+)?/g`, which
 * only captures a modifier glued directly to a dice term. Everything else the
 * caller's character-class validator let through — a space-separated modifier
 * (`1d20 + 5`), a second bonus (`1d20+5+3`), a count-less die (`d20`), a second
 * dice term (`2d6+1d4`), parentheses — was silently dropped from the total. A
 * dropped term produces a plausible number that is simply wrong, which for a
 * dice roller is worse than an error: nothing signals that the formula was not
 * understood.
 *
 * So this module does two things, in this order of importance:
 *  1. Parses the whole formula into dice terms and standalone constants.
 *  2. Consumes the input end to end, and throws a specific error on anything it
 *     cannot represent. Nothing is ever dropped in silence.
 *
 * The supported grammar is deliberately small:
 *
 *     formula  := sign? term ( sign term )*
 *     term     := dice | constant
 *     dice     := digit* 'd' digit+          // a missing count means 1
 *     constant := digit+
 *     sign     := '+' | '-'
 *
 * Parentheses, multiplication and Foundry's modifier syntax (`4d6kh3`, `1d20r1`)
 * are NOT supported and are rejected by name rather than ignored.
 */
/** A dice term such as `2d6`, carried with the sign that precedes it. */
export interface DiceFormulaDiceTerm {
    kind: 'dice';
    sign: 1 | -1;
    count: number;
    sides: number;
}
/** A standalone whole-number constant such as the `5` in `1d20 + 5`. */
export interface DiceFormulaConstantTerm {
    kind: 'constant';
    sign: 1 | -1;
    value: number;
}
export type DiceFormulaTerm = DiceFormulaDiceTerm | DiceFormulaConstantTerm;
/** A term after evaluation: the same shape plus the rolls and the subtotal. */
export type RolledTerm = (DiceFormulaDiceTerm & {
    rolls: number[];
    value: number;
}) | (DiceFormulaConstantTerm & {
    rolls?: undefined;
});
export interface DiceFormulaResult {
    /** Signed sum of every term — never a partial total. */
    total: number;
    /** Human-readable rendering, e.g. `2d6: [3, 5] + 1d4: [2] = 10`. */
    breakdown: string;
    terms: RolledTerm[];
}
/**
 * Upper bound on dice per term. A formula is capped at 100 characters upstream,
 * which still allows five-digit counts; rolling those is pointless and slow, so
 * it is refused explicitly rather than attempted.
 */
export declare const MAX_DICE_PER_TERM = 1000;
/**
 * Parses a dice formula into its terms.
 *
 * @throws {Error} if the formula is empty, or holds anything the grammar above
 *   cannot represent. The message names the offending formula and what was
 *   wrong with it.
 */
export declare function parseDiceFormula(formula: string): DiceFormulaTerm[];
/**
 * Rolls a formula and returns the total together with the terms that produced it.
 *
 * @param formula - Formula in the grammar documented above.
 * @param rng - Uniform [0, 1) source; injectable so tests can be deterministic.
 * @throws {Error} for any formula {@link parseDiceFormula} cannot represent.
 */
export declare function evaluateDiceFormula(formula: string, rng?: () => number): DiceFormulaResult;
//# sourceMappingURL=dice-formula.d.ts.map