import type { Attributes, WeaponInfo } from "../../data-prep/src/types.ts";

export type { Attributes, WeaponInfo };

export const STAT_KEYS = [
	"offence", "shieldHp", "hullHp", "shieldRegen", "hullRepair", "missileDefence",
	"heatTolerance", "energyReserve", "turning", "thrust", "maxSpeed",
	"spareCrew", "jumps", "fuelCapacity", "fuelRegen", "cargo", "cost",
] as const;
export type StatKey = typeof STAT_KEYS[number];

export const STAT_LABELS: Record<StatKey, string> = {
	offence: "Offence (sustained dmg/s)", shieldHp: "Shield HP", hullHp: "Hull HP",
	shieldRegen: "Shield regen /s", hullRepair: "Hull repair /s", missileDefence: "Missile defence",
	heatTolerance: "Heat tolerance", energyReserve: "Energy reserve", turning: "Turning (deg/s)",
	thrust: "Acceleration", maxSpeed: "Max speed", spareCrew: "Spare crew (boarding)",
	jumps: "Jumps per tank", fuelCapacity: "Fuel capacity", fuelRegen: "Fuel regen /s (generators + ramscoop)", cargo: "Cargo space", cost: "Outfit cost (credits)",
};

export type Weights = Record<StatKey, number>;

export const DEFAULT_WEIGHTS: Weights = {
	offence: 80, shieldHp: 50, hullHp: 50, shieldRegen: 20, hullRepair: 10, missileDefence: 20,
	heatTolerance: 10, energyReserve: 10, turning: 30, thrust: 30, maxSpeed: 20,
	spareCrew: 0, jumps: 10, fuelCapacity: 0, fuelRegen: 0, cargo: 0, cost: 10,
};

export interface Constraints {
	instantaneousOnly: boolean;
	noAmmo: boolean;
	requireHyperdrive: boolean;
	requireJumpDrive: boolean;
	positiveEnergy: boolean;
	heatSustainable: boolean;
	ownedLimits: boolean;
	ignoreLicenses: boolean;
	canStrip: boolean;
	minFuel: number;
	minCargo: number;
	minBunks: number;
	// Turning may not fall below this percentage of the current loadout (0 = off).
	minTurnPercent: number;
	// Most credits to spend on new outfits for the whole group (0 = no limit).
	budget: number;
	// Ship attributes every ship must have, e.g. "quantum keystone" (needed to land on planets that "require" it).
	requiredAttributes: string[];
}

export const DEFAULT_CONSTRAINTS: Constraints = {
	instantaneousOnly: true, noAmmo: true, requireHyperdrive: true, requireJumpDrive: true,
	positiveEnergy: true, heatSustainable: true, ownedLimits: false, ignoreLicenses: false,
	canStrip: true, minFuel: 0, minCargo: 0, minBunks: 0,
	minTurnPercent: 70, budget: 0, requiredAttributes: [],
};

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
