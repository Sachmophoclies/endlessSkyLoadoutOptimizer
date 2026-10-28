import type { MapData } from "./stops.ts";

// Shopping-trip routing. Travel is counted in jumps. A ship with a jump drive can also jump to any system within
// `jumpRange` map units (System::DEFAULT_NEIGHBOR_DISTANCE is 100); hyperlanes work for hyperdrives and jump drives alike.
export const DEFAULT_JUMP_RANGE = 100;

export interface RouteOptions {
	useJumpDrive: boolean;
	jumpRange: number;
}

export interface Leg {
	to: string;
	path: string[]; // systems visited after the previous stop, ending with `to` (empty when already there)
}

export interface Trip {
	start: string;
	legs: Leg[];
	jumps: number;
	unreachable: string[]; // stops no route reaches
}

const dist = (map: MapData, a: string, b: string): number => {
	const p = map.systems[a]?.pos, q = map.systems[b]?.pos;
	return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : 0;
};

function neighbours(map: MapData, adjacent: Map<string, Set<string>>, names: string[], system: string, o: RouteOptions): Set<string> {
	const out = new Set(adjacent.get(system) ?? []);
	if(o.useJumpDrive)
		for(const other of names)
			if(other !== system && dist(map, system, other) <= o.jumpRange)
				out.add(other);
	return out;
}

export interface Router {
	path(from: string, to: string): string[] | null; // systems after `from` up to and including `to`
}

// A* over jumps. The heuristic is straight-line distance divided by the longest single hop, which never overestimates.
export function makeRouter(map: MapData, options: RouteOptions): Router {
	const names = Object.keys(map.systems);
	const adjacent = new Map<string, Set<string>>();
	const link = (a: string, b: string): void => void (adjacent.get(a) ?? adjacent.set(a, new Set()).get(a)!).add(b);
	let longest = options.useJumpDrive ? options.jumpRange : 1;
	for(const name of names)
		for(const other of map.systems[name].links)
			if(map.systems[other])
			{
				link(name, other);
				link(other, name);
				longest = Math.max(longest, dist(map, name, other));
			}

	return {
		path(from, to) {
			if(from === to)
				return [];
			if(!map.systems[from] || !map.systems[to])
				return null;
			const h = (s: string): number => dist(map, s, to) / longest;
			const g = new Map<string, number>([[from, 0]]);
			const parent = new Map<string, string>();
			const open = new Map<string, number>([[from, h(from)]]);
			const closed = new Set<string>();
			while(open.size)
			{
				let current = "", best = Infinity;
				for(const [s, f] of open)
					if(f < best)
					{
						best = f;
						current = s;
					}
				open.delete(current);
				if(current === to)
				{
					const out: string[] = [];
					for(let s = to; s !== from; s = parent.get(s)!)
						out.push(s);
					return out.reverse();
				}
				closed.add(current);
				for(const next of neighbours(map, adjacent, names, current, options))
				{
					if(closed.has(next))
						continue;
					const cost = g.get(current)! + 1;
					if(cost < (g.get(next) ?? Infinity))
					{
						g.set(next, cost);
						parent.set(next, current);
						open.set(next, cost + h(next));
					}
				}
			}
			return null;
		},
	};
}

// Visit every stop starting from `start` (no return trip), choosing the order that needs the fewest jumps.
// Up to 8 stops are tried in every order; beyond that the nearest unvisited stop is taken each time.
export function planTrip(map: MapData, start: string, stops: string[], options: RouteOptions): Trip {
	const router = makeRouter(map, options);
	const alreadyThere = stops.includes(start);
	const targets = [...new Set(stops)].filter(s => s !== start);
	const nodes = [start, ...targets];
	const cache = new Map<string, string[] | null>();
	const leg = (a: string, b: string): string[] | null => {
		const key = `${a}\u0000${b}`;
		if(!cache.has(key))
			cache.set(key, router.path(a, b));
		return cache.get(key)!;
	};
	const reachable = targets.filter(t => leg(start, t) !== null || nodes.some(n => n !== t && leg(n, t) !== null));
	const unreachable = targets.filter(t => !reachable.includes(t));
	const cost = (order: string[]): number => {
		let total = 0, at = start;
		for(const s of order)
		{
			const p = leg(at, s);
			if(!p)
				return Infinity;
			total += p.length;
			at = s;
		}
		return total;
	};

	let order: string[] = [];
	if(reachable.length <= 8)
	{
		let best = Infinity;
		const permute = (rest: string[], chosen: string[]): void => {
			if(!rest.length)
			{
				const c = cost(chosen);
				if(c < best)
				{
					best = c;
					order = chosen;
				}
				return;
			}
			rest.forEach((s, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...chosen, s]));
		};
		permute(reachable, []);
	}
	else
	{
		let at = start;
		const rest = new Set(reachable);
		while(rest.size)
		{
			let nearest = "", fewest = Infinity;
			for(const s of rest)
			{
				const p = leg(at, s);
				if(p && p.length < fewest)
				{
					fewest = p.length;
					nearest = s;
				}
			}
			if(!nearest)
				break;
			order.push(nearest);
			rest.delete(nearest);
			at = nearest;
		}
	}

	const legs: Leg[] = alreadyThere ? [{ to: start, path: [] }] : [];
	let at = start, jumps = 0;
	for(const s of order)
	{
		const path = leg(at, s) ?? [];
		legs.push({ to: s, path });
		jumps += path.length;
		at = s;
	}
	return { start, legs, jumps, unreachable: [...unreachable, ...reachable.filter(s => !order.includes(s))] };
}
