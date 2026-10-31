import { type EvalResult, type Genome, type Problem, STAT_KEYS, type StatKey } from "../core/model.ts";
import { capSum } from "../core/stats.ts";

export interface GAParams {
	population: number;
	generations: number;
	mutationRate: number; // base number of edits per child
	seed: number;
	topN: number;
	stagnation: number; // stop after this many generations without improvement
	runs: number; // independent searches with different seeds; the best result is kept
	cap?: number; // largest ratio to the current loadout a stat can earn; default 1.5, Infinity for raw limits
}

export const DEFAULT_GA: GAParams = { population: 500, generations: 300, mutationRate: 2, seed: 1, topN: 1, stagnation: 80, runs: 4 };

// Scores a batch of genomes. Implemented by the worker pool (or in-thread for tests).
export type Evaluator = (genomes: Genome[]) => Promise<EvalResult[]>;

export interface Individual {
	genome: Genome;
	result: EvalResult;
	fitness: number;
}

export interface Progress {
	gen: number;
	best: number;
	mean: number;
	diversity: number;
	feasibleShare: number;
}

export interface GAOutcome {
	best: Individual;
	top: Individual[];
	generations: number;
}

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Maps raw stats to fitness. Each stat is scored against the group's current loadout (capped at 1.5x),
// so one huge stat cannot swamp the rest. Stats the current loadout lacks (reference 0) fall back to the
// running maximum seen so far. Workers return raw stats; normalisation happens here.
export class Scorer {
	readonly hi = new Float64Array(STAT_KEYS.length).fill(1e-9);
	private ref: Float64Array | null = null;
	private problem: Problem;
	private cap: number;
	constructor(problem: Problem, cap = 1.5) {
		this.problem = problem;
		this.cap = cap;
	}

	// The first result is the current loadout; its stats are the reference even if it breaks a constraint.
	setReference(r: EvalResult): void {
		if(!this.ref)
			this.ref = Float64Array.from(r.stats);
	}

	observe(results: EvalResult[]): void {
		for(const r of results)
			if(r.violation === 0)
				for(let k = 0; k < this.hi.length; ++k)
					if(r.stats[k] > this.hi[k])
						this.hi[k] = r.stats[k];
	}

	fitness(r: EvalResult): number {
		if(r.violation > 0)
			return -r.violation;
		const w = this.problem.weights;
		let sum = 0, total = 0;
		for(let k = 0; k < STAT_KEYS.length; ++k)
		{
			const weight = w[STAT_KEYS[k] as StatKey];
			if(!weight)
				continue;
			const scale = this.ref && this.ref[k] > 0 ? this.ref[k] : this.hi[k];
			const norm = Math.max(0, Math.min(this.cap, r.stats[k] / scale));
			total += weight;
			sum += (STAT_KEYS[k] === "cost" ? -1 : 1) * weight * norm;
		}
		return total ? sum / total : 0;
	}
}

export async function runGA(
	problem: Problem, baseline: Genome, ownedPerShip: number[], params: GAParams,
	evaluate: Evaluator, onProgress: (p: Progress) => void, shouldStop: () => boolean,
): Promise<GAOutcome> {
	const rand = mulberry32(params.seed);
	const pool = problem.pool;
	const n = pool.length;
	const maxOf = pool.map((p, i) => Math.min(p.max, ownedPerShip[i] ?? p.max));
	const usable = maxOf.map((m, i) => (m > 0 ? i : -1)).filter(i => i >= 0);
	const scorer = new Scorer(problem, params.cap);

	const used = new Float64Array(problem.capKeys.length);
	const recompute = (g: Genome): void => {
		for(let k = 0; k < used.length; ++k)
			used[k] = problem.hullCap[k] + capSum(problem, g, k);
	};
	const clampToMax = (g: Genome): void => {
		for(let i = 0; i < n; ++i)
			if(g[i] > maxOf[i])
				g[i] = maxOf[i];
	};
	// Remove outfits until every capacity attribute is >= 0 again.
	const repair = (g: Genome): void => {
		clampToMax(g);
		for(let guard = 0; guard < 5000; ++guard)
		{
			recompute(g);
			let worst = -1, worstVal = 0;
			for(let k = 0; k < used.length; ++k)
				if(used[k] < worstVal)
				{
					worstVal = used[k];
					worst = k;
				}
			if(worst < 0)
				return;
			const culprits: number[] = [];
			for(const i of usable)
				if(g[i] > 0 && pool[i].cap[worst] < 0)
					culprits.push(i);
			if(culprits.length === 0)
			{
				// Only positive providers remain deficient (should not happen); drop a random item.
				const any = usable.filter(i => g[i] > 0);
				if(!any.length)
					return;
				g[any[Math.floor(rand() * any.length)]]--;
				continue;
			}
			g[culprits[Math.floor(rand() * culprits.length)]]--;
		}
	};
	const fits = (g: Genome, i: number): boolean => {
		g[i]++;
		recompute(g);
		let ok = g[i] <= maxOf[i];
		for(let k = 0; ok && k < used.length; ++k)
			if(used[k] < 0)
				ok = false;
		if(!ok)
			g[i]--;
		return ok;
	};
	const fill = (g: Genome, tries: number): void => {
		for(let t = 0; t < tries && usable.length; ++t)
			fits(g, usable[Math.floor(rand() * usable.length)]);
	};
	const randomGenome = (): Genome => {
		const g = new Int16Array(n);
		fill(g, 20 + Math.floor(rand() * 60));
		return g;
	};
	const mutate = (g: Genome, edits: number): void => {
		for(let e = 0; e < edits && usable.length; ++e)
		{
			const r = rand();
			const present = usable.filter(i => g[i] > 0);
			if(r < 0.35 || present.length === 0)
				fits(g, usable[Math.floor(rand() * usable.length)]);
			else if(r < 0.5)
				g[present[Math.floor(rand() * present.length)]]--;
			else
			{
				// Swap: drop one outfit then try to add another (preferring the same slot/category).
				const out = present[Math.floor(rand() * present.length)];
				g[out]--;
				const same = usable.filter(i => pool[i].category === pool[out].category);
				const from = rand() < 0.7 && same.length ? same : usable;
				fits(g, from[Math.floor(rand() * from.length)]);
			}
		}
	};

	// Initial population: current loadout (minus banned items), random builds.
	const start = Int16Array.from(baseline);
	repair(start);
	let population: Genome[] = [start];
	while(population.length < params.population)
	{
		const g = rand() < 0.3 ? Int16Array.from(start) : randomGenome();
		if(g === start || rand() < 0.3)
			mutate(g, 1 + Math.floor(rand() * 6));
		fill(g, 5);
		population.push(g);
	}

	let archive: Individual[] = [];
	let best: Individual | null = null;
	let sinceImprovement = 0;
	let gen = 0;
	for(; gen < params.generations && !shouldStop(); ++gen)
	{
		const results = await evaluate(population);
		scorer.setReference(results[0]);
			scorer.observe(results);
		let scored: Individual[] = population.map((genome, i) => ({
			genome, result: results[i], fitness: 0,
		}));
		for(const ind of scored)
			ind.fitness = scorer.fitness(ind.result);
		// Re-score the archive under the current normalisation.
		for(const ind of archive)
			ind.fitness = scorer.fitness(ind.result);
		scored.sort((a, b) => b.fitness - a.fitness);

		archive = updateArchive(archive.concat(scored.slice(0, Math.max(params.topN * 4, 10))), params.topN);
		const top = archive[0];
		if(!best || top.fitness > best.fitness + 1e-9)
		{
			sinceImprovement = 0;
		}
		else
			++sinceImprovement;
		best = top;

		const mean = scored.reduce((s, x) => s + x.fitness, 0) / scored.length;
		onProgress({
			gen: gen + 1, best: best.fitness, mean, diversity: diversity(scored, rand),
			feasibleShare: scored.filter(x => x.result.violation === 0).length / scored.length,
		});
		if(sinceImprovement >= params.stagnation)
		{
			++gen;
			break;
		}

		// Breed the next generation.
		const elite = Math.max(2, Math.floor(scored.length * 0.03));
		const next: Genome[] = scored.slice(0, elite).map(x => Int16Array.from(x.genome));
		const edits = params.mutationRate + (sinceImprovement > 10 ? Math.min(6, sinceImprovement / 10) : 0);
		const pick = (): Genome => {
			let winner = scored[Math.floor(rand() * scored.length)];
			for(let k = 1; k < 4; ++k)
			{
				const c = scored[Math.floor(rand() * scored.length)];
				if(c.fitness > winner.fitness)
					winner = c;
			}
			return winner.genome;
		};
		while(next.length < params.population)
		{
			const a = pick(), b = pick();
			const child = new Int16Array(n);
			for(let i = 0; i < n; ++i)
				child[i] = rand() < 0.5 ? a[i] : b[i];
			repair(child);
			mutate(child, 1 + Math.floor(rand() * (edits + 1)));
			fill(child, 3);
			next.push(child);
		}
		population = next;
		// Yield so the UI can paint between generations.
		await new Promise(r => setTimeout(r, 0));
	}

	if(!best)
		throw new Error("No generations ran");

	// Prune pass: drop outfits that do not improve fitness (the fill step adds neutral ones).
	for(const ind of archive)
	{
		for(let round = 0; round < 40; ++round)
		{
			const present = usable.filter(i => ind.genome[i] > 0);
			const trials = present.map(i => {
				const g = Int16Array.from(ind.genome);
				g[i]--;
				return g;
			});
			if(!trials.length)
				break;
			const results = await evaluate(trials);
			let pick = -1, pickFit = ind.fitness - 1e-9;
			results.forEach((r, k) => {
				const f = scorer.fitness(r);
				if(r.violation === 0 && f >= pickFit)
				{
					pickFit = f;
					pick = k;
				}
			});
			if(pick < 0)
				break;
			ind.genome = trials[pick];
			ind.result = results[pick];
			ind.fitness = pickFit;
		}
	}
	archive.sort((a, b) => b.fitness - a.fitness);
	return { best: archive[0], top: archive, generations: gen };
}

// Keep the best N mutually distinct individuals (Jaccard distance over the outfit sets).
function updateArchive(candidates: Individual[], topN: number): Individual[] {
	const sorted = [...candidates].sort((a, b) => b.fitness - a.fitness);
	const kept: Individual[] = [];
	for(const c of sorted)
	{
		if(kept.length >= topN)
			break;
		if(kept.every(k => distance(k.genome, c.genome) > 0.15))
			kept.push(c);
	}
	return kept;
}

function distance(a: Genome, b: Genome): number {
	let inter = 0, union = 0;
	for(let i = 0; i < a.length; ++i)
	{
		inter += Math.min(a[i], b[i]);
		union += Math.max(a[i], b[i]);
	}
	return union ? 1 - inter / union : 0;
}

function diversity(pop: Individual[], rand: () => number): number {
	let sum = 0;
	const samples = 40;
	for(let s = 0; s < samples; ++s)
		sum += distance(pop[Math.floor(rand() * pop.length)].genome, pop[Math.floor(rand() * pop.length)].genome);
	return sum / samples;
}

const HILL_ROUNDS = 40;

// Several independent GA runs (seeds seed, seed + 7919, ...) share one evaluator and run side by side. Their winners are
// compared under one scorer, and the best is then polished by hill climbing.
export async function runSearch(
	problem: Problem, baseline: Genome, ownedPerShip: number[], params: GAParams,
	evaluate: Evaluator, onProgress: (p: Progress) => void, shouldStop: () => boolean,
): Promise<GAOutcome> {
	// A blank or invalid box in the settings must not reach Array(n).
	const whole = (v: number, fallback: number, min: number, max: number): number =>
		Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
	const runs = whole(params.runs, DEFAULT_GA.runs, 1, 16);
	params = {
		...params, population: whole(params.population, DEFAULT_GA.population, 4, 5000),
		generations: whole(params.generations, DEFAULT_GA.generations, 1, 5000),
		stagnation: whole(params.stagnation, DEFAULT_GA.stagnation, 1, 5000),
	};
	const latest: Progress[] = [];
	const finished: boolean[] = new Array(runs).fill(false);
	const report = (): void => {
		const ps = latest.filter(Boolean);
		const avg = (f: (p: Progress) => number): number => ps.reduce((s, p) => s + f(p), 0) / ps.length;
		let gens = 0;
		for(let k = 0; k < runs; ++k)
			gens += finished[k] ? params.generations : latest[k]?.gen ?? 0;
		onProgress({
			gen: Math.round(gens / runs), best: Math.max(...ps.map(p => p.best)), mean: avg(p => p.mean),
			diversity: avg(p => p.diversity), feasibleShare: avg(p => p.feasibleShare),
		});
	};
	const outcomes = await Promise.all(Array.from({ length: runs }, (_, k) =>
		runGA(problem, baseline, ownedPerShip, { ...params, seed: params.seed + k * 7919 }, evaluate,
			p => { latest[k] = p; report(); }, shouldStop).finally(() => { finished[k] = true; })));

	// One scorer for everyone, referenced to the current loadout, so the runs' winners are comparable.
	const scorer = new Scorer(problem, params.cap);
	scorer.setReference((await evaluate([baseline]))[0]);
	const finalists = outcomes.map(o => o.best);
	scorer.observe(finalists.map(f => f.result));
	for(const f of finalists)
		f.fitness = scorer.fitness(f.result);
	finalists.sort((a, b) => b.fitness - a.fitness);
	const best = shouldStop() ? finalists[0] : await hillClimb(problem, ownedPerShip, finalists[0], scorer, evaluate, shouldStop);
	return { best, top: [best], generations: Math.max(...outcomes.map(o => o.generations)) };
}

// Steepest-ascent local search: every single add, remove and swap that keeps the capacities legal is scored, and the best
// improvement is taken until none is left.
async function hillClimb(
	problem: Problem, ownedPerShip: number[], start: Individual, scorer: Scorer, evaluate: Evaluator, shouldStop: () => boolean,
): Promise<Individual> {
	const pool = problem.pool;
	const maxOf = pool.map((p, i) => Math.min(p.max, ownedPerShip[i] ?? p.max));
	const usable = maxOf.map((m, i) => (m > 0 ? i : -1)).filter(i => i >= 0);
	const legal = (g: Genome): boolean => {
		for(const i of usable)
			if(g[i] > maxOf[i])
				return false;
		for(let k = 0; k < problem.capKeys.length; ++k)
			if(problem.hullCap[k] + capSum(problem, g, k) < 0)
				return false;
		return true;
	};
	let current = start;
	for(let round = 0; round < HILL_ROUNDS && !shouldStop(); ++round)
	{
		const present = usable.filter(i => current.genome[i] > 0);
		const neighbours: Genome[] = [];
		const consider = (g: Genome): void => {
			if(legal(g))
				neighbours.push(g);
		};
		for(const i of usable)
		{
			const added = Int16Array.from(current.genome);
			added[i]++;
			consider(added);
		}
		for(const o of present)
		{
			const removed = Int16Array.from(current.genome);
			removed[o]--;
			consider(removed);
			for(const i of usable)
			{
				if(i === o)
					continue;
				const swapped = Int16Array.from(removed);
				swapped[i]++;
				consider(swapped);
			}
		}
		if(!neighbours.length)
			break;
		const results = await evaluate(neighbours);
		let pick = -1, pickFit = current.fitness + 1e-9;
		results.forEach((r, k) => {
			const f = scorer.fitness(r);
			if(r.violation === 0 && f > pickFit)
			{
				pickFit = f;
				pick = k;
			}
		});
		if(pick < 0)
			break;
		current = { genome: neighbours[pick], result: results[pick], fitness: pickFit };
	}
	return current;
}
