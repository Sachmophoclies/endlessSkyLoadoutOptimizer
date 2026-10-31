import { type Genome, type Problem, STAT_KEYS, type StatKey } from "../core/model.ts";
import { evaluate } from "../core/stats.ts";
import { DEFAULT_GA, type Evaluator, type GAParams, runSearch } from "./ga.ts";

// Where a group's current loadout sits between the cheapest valid loadout (floor) and the best that one stat alone
// can reach with the pool and non-negotiables in force (ceiling). Arrays are indexed like STAT_KEYS.
export interface Limits {
	current: number[];
	floor: number[];
	ceiling: number[];
}

const LIMIT_GA: GAParams = { ...DEFAULT_GA, population: 120, generations: 60, stagnation: 20, runs: 2, cap: Infinity };

const only = (problem: Problem, key: StatKey): Problem => ({
	...problem, weights: Object.fromEntries(STAT_KEYS.map(k => [k, k === key ? 1 : 0])) as Problem["weights"],
});

// One search per stat, each weighting that stat alone, plus one for the cheapest valid loadout. Returns null if stopped.
export async function computeLimits(
	problem: Problem, baseline: Genome, ownedPerShip: number[], evaluator: Evaluator,
	shouldStop: () => boolean, onStat: (done: number, total: number) => void,
): Promise<Limits | null> {
	const current = Array.from(evaluate(problem, baseline).stats);
	const floor = current.slice();
	const ceiling = current.slice();
	const total = STAT_KEYS.length;
	let done = 0;
	for(let k = 0; k < total; ++k)
	{
		const key = STAT_KEYS[k];
		const cheapest = key === "cost";
		const out = await runSearch(only(problem, key), baseline, ownedPerShip, LIMIT_GA, evaluator, () => {}, shouldStop);
		if(shouldStop())
			return null;
		if(cheapest)
			floor.splice(0, floor.length, ...out.best.result.stats);
		else
			ceiling[k] = Math.max(current[k], out.best.result.stats[k]);
		onStat(++done, total);
	}
	// The floor's own stats are the reference for the low end; a stat the cheapest build exceeds keeps the lower value.
	for(let k = 0; k < total; ++k)
		floor[k] = Math.min(floor[k], current[k]);
	return { current, floor, ceiling };
}
