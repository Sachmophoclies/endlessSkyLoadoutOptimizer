import type { OutfitData } from "../../data-prep/src/types.ts";

// Attributes where a bigger number is worse for the ship.
const LOWER_IS_BETTER = /consumption|inefficiency|^drag$|heat generation|^(thrusting|turning|reverse thrusting|afterburner|shield|hull|cloaking|scan|ramscoop)? ?(energy|heat|fuel)$|required crew|mandatory crew|cloak.*(energy|fuel|heat)/;
const FLAGS = new Set(["unplunderable", "installable", "unique", "minable", "atrocity", "hidden", "map", "mass"]);
const CATEGORIES = new Set(["Engines", "Systems", "Power"]);
const MAX_COPIES = 4;

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every(l => b.includes(l));

// Outfits whose purpose the attributes do not show (a brig only takes up space) are never judged: they need a gain to compare.
const hasGain = (x: OutfitData): boolean =>
	Object.entries(x.attributes).some(([a, v]) => !FLAGS.has(a) && (LOWER_IS_BETTER.test(a) ? v < 0 : v > 0));

// `m` copies of `y` are at least as good as `k` copies of `x` in every attribute, and no dearer in cost, mass or space.
// Weapons and ammunition are not compared, and neither are outfits that change how crew work (`automaton`).
function dominates(y: OutfitData, m: number, x: OutfitData, k: number): boolean {
	let strict = false;
	for(const a of new Set([...Object.keys(x.attributes), ...Object.keys(y.attributes)]))
	{
		if(FLAGS.has(a))
			continue;
		const d = (LOWER_IS_BETTER.test(a) ? -1 : 1) * (m * (y.attributes[a] ?? 0) - k * (x.attributes[a] ?? 0));
		if(d < -1e-9)
			return false;
		if(d > 1e-9)
			strict = true;
	}
	const cost = k * x.cost - m * y.cost, mass = k * x.mass - m * y.mass;
	return cost >= 0 && mass >= 0 && (strict || cost > 0 || mass > 0);
}

// How many copies of `x` a loadout can usefully hold: `k` copies can always be traded for `m <= k` copies of an outfit that
// does everything they do for no more, so the search never needs `k` of them. A different outfit with the same licenses
// has to dominate (a license an outfit needs is part of what it is). Returns null when nothing dominates `x`.
export function usefulCopies(x: OutfitData, others: Iterable<OutfitData>): number | null {
	if(x.weapon || !CATEGORIES.has(x.category) || x.attributes["automaton"] !== undefined || !hasGain(x))
		return null;
	let best: number | null = null;
	for(const y of others)
	{
		if(y === x || y.weapon || !CATEGORIES.has(y.category) || y.attributes["automaton"] !== undefined || !same(x.licenses, y.licenses))
			continue;
		for(let k = 1; k <= MAX_COPIES && (best === null || k - 1 < best); ++k)
			for(let m = 1; m <= k; ++m)
				if(dominates(y, m, x, k))
				{
					best = k - 1;
					break;
				}
	}
	return best;
}
