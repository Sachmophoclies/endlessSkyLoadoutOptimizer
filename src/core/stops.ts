// Trip planner for the shopping list: which systems to visit to buy everything with the fewest stops.

export interface MapData {
	systems: Record<string, { pos: [number, number]; links: string[]; planets: string[] }>;
	planetSets: Record<string, string[]>; // planet -> outfitter set names
	landing: Record<string, Landing>; // planet -> what it takes to land (planets with an outfitter)
	requires: string[]; // ship attributes some planets demand before landing
}

export interface Landing {
	government: string;
	requiredReputation: number;
	bribe: number;
	bribeThreshold: number;
}

// Planets the pilot can land on (Politics::CanLand): reputation with the planet's government reaches the requirement,
// or the planet takes bribes and the reputation clears the bribe threshold. Planets without rules are open.
export function landablePlanets(planets: Iterable<string>, map: MapData, reputation: Record<string, number>): string[] {
	return [...planets].filter(planet => {
		const l = map.landing[planet];
		if(!l || !l.requiredReputation)
			return true;
		const rep = reputation[l.government] ?? 0;
		return rep >= l.requiredReputation || (l.bribe > 0 && rep >= l.bribeThreshold);
	});
}

export interface Purchase {
	name: string;
	count: number;
	cost: number; // total credits for `count` copies
}

export interface Stop {
	system: string;
	distance: number; // straight-line map distance from Sol
	jumps: number | null; // hyperlane jumps from Sol, when the base map links the two
	planets: Array<{ planet: string; items: Purchase[] }>;
}

export interface TripPlan {
	stops: Stop[]; // nearest Sol first
	unplaced: Purchase[]; // not sold on any visited planet
}

const ORIGIN = "Sol";

// Jumps from Sol along hyperlanes (links are two-way even when only one side declares them). Regions that the base map
// only joins through story events or wormholes are not reached.
export function jumpsFromSol(map: MapData): Map<string, number> {
	const adjacent = new Map<string, Set<string>>();
	const link = (a: string, b: string): void => void (adjacent.get(a) ?? adjacent.set(a, new Set()).get(a)!).add(b);
	for(const [name, system] of Object.entries(map.systems))
		for(const other of system.links)
		{
			link(name, other);
			link(other, name);
		}
	const jumps = new Map<string, number>([[ORIGIN, 0]]);
	const queue = [ORIGIN];
	for(let i = 0; i < queue.length; ++i)
		for(const next of adjacent.get(queue[i]) ?? [])
			if(!jumps.has(next))
			{
				jumps.set(next, jumps.get(queue[i])! + 1);
				queue.push(next);
			}
	return jumps;
}

// Greedy set cover over systems with a visited outfitter: repeatedly visit the system that sells the most of what is
// still missing (ties go to the one closest to Sol on the map). Then every item is bought at the closest chosen stop that sells it,
// and stops left with nothing to buy are dropped.
export function planStops(
	buy: Purchase[], map: MapData, sets: Record<string, string[]>, visitedPlanets: Iterable<string>,
): TripPlan {
	const jumps = jumpsFromSol(map);
	const sol = map.systems[ORIGIN]?.pos ?? [0, 0];
	const euclid = (system: string): number => {
		const p = map.systems[system]?.pos ?? [0, 0];
		return Math.hypot(p[0] - sol[0], p[1] - sol[1]);
	};
	const closer = (a: string, b: string): number => euclid(a) - euclid(b) || a.localeCompare(b);

	const wanted = new Set(buy.map(b => b.name));
	const visited = new Set(visitedPlanets);
	// system -> outfit -> visited planets there that sell it
	const sells = new Map<string, Map<string, string[]>>();
	for(const [system, data] of Object.entries(map.systems))
		for(const planet of data.planets)
		{
			if(!visited.has(planet))
				continue;
			for(const setName of map.planetSets[planet] ?? [])
				for(const item of sets[setName] ?? [])
					if(wanted.has(item))
					{
						const bySystem = sells.get(system) ?? sells.set(system, new Map()).get(system)!;
						const planets = bySystem.get(item) ?? bySystem.set(item, []).get(item)!;
						if(!planets.includes(planet))
							planets.push(planet);
					}
		}

	const missing = new Set([...wanted].filter(name => [...sells.values()].some(m => m.has(name))));
	const unplaced = buy.filter(b => !missing.has(b.name));
	const chosen: string[] = [];
	while(missing.size)
	{
		let best = "", bestCount = 0;
		for(const [system, items] of sells)
		{
			let count = 0;
			for(const name of missing)
				if(items.has(name))
					++count;
			if(count > bestCount || (count === bestCount && count > 0 && closer(system, best) < 0))
			{
				best = system;
				bestCount = count;
			}
		}
		chosen.push(best);
		for(const name of sells.get(best)!.keys())
			missing.delete(name);
	}
	chosen.sort(closer);

	const stops = new Map<string, Stop>();
	for(const purchase of buy)
	{
		const system = chosen.find(s => sells.get(s)?.has(purchase.name));
		if(!system)
			continue;
		const here = sells.get(system)!;
		// Within a system, prefer the planet that sells the most of this stop's items.
		const planetLoad = new Map<string, number>();
		for(const planets of here.values())
			planets.forEach(p => planetLoad.set(p, (planetLoad.get(p) ?? 0) + 1));
		const planet = [...here.get(purchase.name)!].sort((a, b) => planetLoad.get(b)! - planetLoad.get(a)! || a.localeCompare(b))[0];
		const stop = stops.get(system) ?? stops.set(system, { system, distance: euclid(system), jumps: jumps.get(system) ?? null, planets: [] }).get(system)!;
		const entry = stop.planets.find(p => p.planet === planet) ?? stop.planets[stop.planets.push({ planet, items: [] }) - 1];
		entry.items.push(purchase);
	}
	return { stops: [...stops.values()].sort((a, b) => closer(a.system, b.system)), unplaced };
}
