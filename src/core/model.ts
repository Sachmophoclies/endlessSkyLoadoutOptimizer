import type { Attributes, WeaponInfo } from "../../data-prep/src/types.ts";

export type { Attributes, WeaponInfo };

export const STAT_KEYS = [
	"offence", "shieldRegen", "hullRepair", "hullProtection", "missileDefence",
	"heatTolerance", "energyReserve", "energyGeneration", "turning", "thrust", "maxSpeed",
	"spareCrew", "jumps", "fuelCapacity", "fuelRegen", "cargo", "cost",
] as const;
export type StatKey = typeof STAT_KEYS[number];

export const STAT_LABELS: Record<StatKey, string> = {
	offence: "Offence (sustained dmg/s)",
		shieldRegen: "Shield regen /s", hullRepair: "Hull repair /s", missileDefence: "Missile defence",
		hullProtection: "Hull protection (x damage absorbed)",
	heatTolerance: "Heat tolerance", energyReserve: "Energy reserve", energyGeneration: "Energy generation /s", turning: "Turning (deg/s)",
	thrust: "Acceleration", maxSpeed: "Max speed", spareCrew: "Spare crew (boarding)",
	jumps: "Jumps per tank", fuelCapacity: "Fuel capacity", fuelRegen: "Fuel regen /s (generators + ramscoop)", cargo: "Cargo space", cost: "Outfit cost (credits)",
};

export type Weights = Record<StatKey, number>;

export const DEFAULT_WEIGHTS: Weights = {
	offence: 80, shieldRegen: 20, hullRepair: 10, hullProtection: 10, missileDefence: 20,
	heatTolerance: 10, energyReserve: 10, energyGeneration: 10, turning: 30, thrust: 30, maxSpeed: 20,
	spareCrew: 0, jumps: 10, fuelCapacity: 0, fuelRegen: 0, cargo: 0, cost: 10,
};

// One entry of the "must contain" and "must not contain" lists. An outfit entry names an outfit (a count applies to must
// contain: at least that many per ship). An attribute entry stands for any outfit that provides the attribute, such as
// "jump drive" or the "quantum keystone" a planet requires.
export interface Requirement {
	kind: "outfit" | "attribute";
	name: string;
	count: number;
}

const ATTRIBUTE_LABELS: Record<string, string> = {
	"hyperdrive": "Hyperdrive", "jump drive": "Jump drive", "ramscoop": "Ramscoop", "afterburner thrust": "Afterburner",
};

export const requirementLabel = (r: Requirement): string =>
	r.kind === "outfit" ? r.name : (ATTRIBUTE_LABELS[r.name] ?? r.name.charAt(0).toUpperCase() + r.name.slice(1));

// A hyperdrive requirement is also met by a scram drive.
export const attributeMet = (name: string, have: (attribute: string) => number): boolean =>
	have(name) > 0 || (name === "hyperdrive" && have("scram drive") > 0);

export const attributeBans = (r: Requirement, attributes: Record<string, number>): boolean =>
	(attributes[r.name] ?? 0) > 0 || (r.name === "hyperdrive" && (attributes["scram drive"] ?? 0) > 0);

export interface Constraints {
	instantaneousOnly: boolean;
	noAmmo: boolean;
	noNegativeShieldProtection: boolean;
	positiveEnergy: boolean;
	heatSustainable: boolean;
	ownedLimits: boolean;
	ignoreLicenses: boolean;
	plunder: "none" | "aggressive" | "all"; // plunderable outfits: not at all, only from governments hostile to you, or any
	includeShrouded: boolean;
	minFuel: number;
	maxFuel: number; // 0 = no limit
	minCargo: number;
	minBunks: number;
	mustContain: Requirement[];
	mustNotContain: Requirement[];
}

export const DEFAULT_CONSTRAINTS: Constraints = {
	instantaneousOnly: true, noAmmo: true, noNegativeShieldProtection: true,
	positiveEnergy: true, heatSustainable: true, ownedLimits: false, ignoreLicenses: false,
	plunder: "none", includeShrouded: true, minFuel: 0, maxFuel: 2000, minCargo: 0, minBunks: 0,
	mustContain: [
		{ kind: "attribute", name: "hyperdrive", count: 1 },
		{ kind: "attribute", name: "jump drive", count: 1 },
		{ kind: "attribute", name: "ramscoop", count: 1 },
	],
	mustNotContain: [{ kind: "attribute", name: "afterburner thrust", count: 1 }],
};

// Constraints from a saved loadout. Older files stored the lists as separate yes/no settings.
export function loadConstraints(savedConstraints: object): Constraints {
	const saved = savedConstraints as Record<string, unknown>;
	const old = saved as Record<string, unknown> & { plunder?: unknown; requiredAttributes?: string[] };
	const c: Constraints = { ...DEFAULT_CONSTRAINTS, ...saved } as Constraints;
	c.plunder = old.plunder === true ? "all" : old.plunder === "aggressive" || old.plunder === "all" ? old.plunder : "none";
	const attribute = (name: string): Requirement => ({ kind: "attribute", name, count: 1 });
	if(!Array.isArray(saved.mustContain))
		c.mustContain = [
			...(saved.requireHyperdrive === false ? [] : [attribute("hyperdrive")]),
			...(saved.requireJumpDrive === false ? [] : [attribute("jump drive")]),
			...(saved.requireRamscoop === false ? [] : [attribute("ramscoop")]),
			...(old.requiredAttributes ?? []).map(attribute),
		];
	if(!Array.isArray(saved.mustNotContain))
		c.mustNotContain = saved.forbidAfterburner === false ? [] : [attribute("afterburner thrust")];
	for(const legacy of ["requireHyperdrive", "requireJumpDrive", "requireRamscoop", "forbidAfterburner", "requiredAttributes"])
		delete (c as unknown as Record<string, unknown>)[legacy];
	return c;
}

// Advanced options: status-damage weights and model parameters.
export interface Advanced {
	ion: number; disruption: number; slowing: number; scrambling: number;
	// Fraction of time thrusters/steering are assumed active when budgeting energy and heat.
	moveDuty: number;
	// Seconds of fire an ammo weapon must last to count at full value.
	ammoHorizon: number;
	// Seconds over which batteries may cover an energy deficit.
	batteryHorizon: number;
}

export const DEFAULT_ADVANCED: Advanced = {
	ion: 1, disruption: 1, slowing: 1, scrambling: 0, moveDuty: 0.5, ammoHorizon: 60, batteryHorizon: 30,
};

export interface PoolItem {
	locked?: boolean; // a unique outfit the group already carries: the search keeps exactly the current count
	name: string;
	category: string;
	source: string;
	mass: number;
	cost: number;
	attrs: Attributes;
	weapon: WeaponInfo | null;
	slot: "gun" | "turret" | null;
	// Maximum count the search may use; 0 means banned (kept only so the current loadout can be scored).
	max: number;
	// Index of this weapon's ammo outfit in the pool, or -1.
	ammoIdx: number;
	// Values of Problem.capKeys for this outfit.
	cap: number[];
}

export interface Problem {
	hullName: string;
	hull: Attributes;
	hullMass: number;
	pool: PoolItem[];
	// Attributes that must stay >= 0 (outfit space, ports, ammo capacities, ...).
	capKeys: string[];
	hullCap: number[];
	weights: Weights;
	constraints: Constraints;
	adv: Advanced;
	// Copies of each pool outfit already held per ship (installed, storage, cargo), and the group size.
	havePerShip: number[];
	shipCount: number;
}

export type Genome = Int16Array;

export interface EvalResult {
	stats: Float64Array; // indexed like STAT_KEYS
	violation: number; // 0 = satisfies all hard constraints
}
