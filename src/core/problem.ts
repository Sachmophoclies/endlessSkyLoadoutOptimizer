import type { OutfitData } from "../../data-prep/src/types.ts";
import type { SaveData, ShipGroup } from "../save/parseSave.ts";
import type { Advanced, Constraints, Genome, PoolItem, Problem, Weights } from "./model.ts";

// Attributes that bound what can be installed. Only negative contributions count as "costs".
const CAP_RE = /(capacity|space|ports|mounts|connection point)$/;
const NOT_CAP = new Set(["energy capacity", "fuel capacity", "heat capacity", "cargo space"]);
const HULL_KEYS = ["outfit space", "weapon capacity", "engine capacity", "gun ports", "turret mounts"];
const MAX_UNBOUNDED = 500; // ammo and similar items bounded only by capacity providers

export interface BuildOptions {
	group: ShipGroup;
	save: SaveData;
	outfits: OutfitData[];
	sources: Set<string>;
	weights: Weights;
	constraints: Constraints;
	adv: Advanced;
}

export interface Built {
	problem: Problem;
	baseline: Genome; // the group's current loadout, indexed like problem.pool
	ownedPerShip: number[]; // available copies per ship (Infinity when buyable and unlimited)
	shipCount: number;
}

const isCap = (key: string, value: number): boolean => value < 0 && CAP_RE.test(key) && !NOT_CAP.has(key);

export function buildProblem(o: BuildOptions): Built {
	const { group, save, constraints: con } = o;
	const byName = new Map(o.outfits.map(x => [x.name, x]));
	const n = group.ships.length;
	const licensed = new Set(save.licenses);

	// Total owned: installed on any of your ships, in storage, in cargo.
	const owned = new Map<string, number>();
	const add = (name: string, count: number): void => void owned.set(name, (owned.get(name) ?? 0) + count);
	for(const ship of save.ships)
		for(const [name, c] of Object.entries(ship.outfits))
			add(name, c);
	for(const [name, c] of Object.entries(save.storage))
		add(name, c);
	for(const [name, c] of Object.entries(save.cargo))
		add(name, c);

	const ammoNames = new Set<string>();
	for(const x of o.outfits)
		// Usage 0 (e.g. Drak weapons with `ammo "Jump Drive" 0`) only requires the outfit to be installed.
		if(x.weapon?.ammo?.usage)
			ammoNames.add(x.weapon.ammo.outfit);

	// Copies of an outfit can be bought, or (if allowed) plundered: not sold anywhere, no license needed.
	const buyableOf = (data: OutfitData): boolean => data.sold && (con.ignoreLicenses || data.licenses.every(l => licensed.has(l)));
	const obtainable = (data: OutfitData): boolean => buyableOf(data) || (con.plunder && data.plunderable);

	const candidates: Array<{ data: OutfitData; max: number }> = [];
	for(const data of o.outfits)
	{
		const current = group.outfits[data.name] ?? 0;
		const hasCost = Object.entries(data.attributes).some(([k, v]) => isCap(k, v));
		if(!hasCost && !current)
			continue;
		const ownedPerShip = Math.floor((owned.get(data.name) ?? 0) / n);
		let max = obtainable(data) && !con.ownedLimits ? MAX_UNBOUNDED : ownedPerShip;
		if(!obtainable(data) && !current && ownedPerShip === 0)
			continue;
		let banned = !o.sources.has(data.source);
		const w = data.weapon;
		if(w?.tractorBeam)
			banned = true;
		if(con.instantaneousOnly && w && !w.antiMissile && !w.instantaneous)
			banned = true;
		if(con.noAmmo && (w?.ammo?.usage || ammoNames.has(data.name)))
			banned = true;
		if(banned && !current)
			continue;
		max = Math.min(max, hullBound(data, group.hull));
		candidates.push({ data, max: banned ? 0 : max });
	}
	candidates.sort((a, b) => a.data.name.localeCompare(b.data.name));

	const index = new Map(candidates.map((c, i) => [c.data.name, i]));
	const capKeys = new Set(HULL_KEYS);
	for(const c of candidates)
		for(const [k, v] of Object.entries(c.data.attributes))
			if(isCap(k, v))
				capKeys.add(k);
	const keys = [...capKeys];

	const pool: PoolItem[] = candidates.map(({ data, max }) => ({
		name: data.name, category: data.category, source: data.source, mass: data.mass, cost: data.cost,
		attrs: data.attributes, weapon: data.weapon, slot: data.slot, max,
		ammoIdx: data.weapon?.ammo ? (index.get(data.weapon.ammo.outfit) ?? -1) : -1,
		cap: keys.map(k => data.attributes[k] ?? 0),
	}));

	const baseline = new Int16Array(pool.length);
	for(const [name, c] of Object.entries(group.outfits))
	{
		const i = index.get(name);
		if(i !== undefined)
			baseline[i] = c;
	}

	const problem: Problem = {
		hullName: group.model, hull: group.hull, hullMass: group.hullMass, pool,
		capKeys: keys, hullCap: keys.map(k => group.hull[k] ?? 0),
		weights: o.weights, constraints: con, adv: o.adv,
		havePerShip: candidates.map(c => Math.floor((owned.get(c.data.name) ?? 0) / n)), shipCount: n,
	};
	const ownedPerShip = candidates.map(c => {
		return obtainable(c.data) && !con.ownedLimits ? Infinity : Math.floor((owned.get(c.data.name) ?? 0) / n);
	});
	return { problem, baseline, ownedPerShip, shipCount: n };
}

// Upper bound from the hull alone: floor(hull value / outfit cost) for each hull-bound attribute.
function hullBound(data: OutfitData, hull: Record<string, number>): number {
	let bound = Infinity;
	for(const key of HULL_KEYS)
	{
		const v = data.attributes[key] ?? 0;
		if(v < 0)
			bound = Math.min(bound, Math.floor((hull[key] ?? 0) / -v));
	}
	return bound === Infinity ? MAX_UNBOUNDED : bound;
}

// Non-negotiables that cannot be met. The jump-drive error appears if and only if "must have jump drive" is on,
// plunderable outfits are off, nothing sells a jump drive, and your ships, storage and cargo hold fewer than
// one jump drive per ship in this group.
export function unsatisfiable(problem: Problem): string[] {
	const con = problem.constraints;
	const out: string[] = [];
	const hasDrive = (key: string): boolean => (problem.hull[key] ?? 0) > 0
		|| problem.pool.some((p, i) => (p.attrs[key] ?? 0) > 0 && (problem.havePerShip[i] > 0 || p.max > 0));
	if(con.requireHyperdrive && !hasDrive("hyperdrive") && !hasDrive("scram drive"))
		out.push("Must have hyperdrive: no hyperdrive or scram drive is available to every ship in this group");
	if(con.requireJumpDrive && !con.plunder && !hasDrive("jump drive"))
		out.push(`Must have jump drive: "Include plunderable outfits" is off, and your ships, storage and cargo hold no jump drive to give each of this group's ${problem.shipCount} ships`);
	for(const attribute of con.requiredAttributes)
		if(!hasDrive(attribute))
			out.push(`Must have ${attribute}: no outfit that provides it is available to every ship in this group`);
	return out;
}
