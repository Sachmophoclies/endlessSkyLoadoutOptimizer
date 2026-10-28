// Shapes of the JSON files emitted for the web app (public/data/*.json).

export type Attributes = Record<string, number>;

export interface WeaponInfo {
	reload: number;
	burstCount: number;
	burstReload: number;
	// Total lifetime in frames, including the longest submunition.
	totalLifetime: number;
	range: number;
	velocity: number;
	acceleration: number;
	homing: boolean;
	// Nothing remains in flight after the frame it fires: totalLifetime === 1 (see source-findings.md).
	instantaneous: boolean;
	// Anti-missile strength (0 = not an anti-missile weapon) and tractor beam strength.
	antiMissile: number;
	tractorBeam: number;
	missileStrength: number;
	ammo: { outfit: string; usage: number } | null;
	// Damage per shot by channel, submunitions included. Status channels are raw (game shows them x100).
	damage: Record<string, number>;
	// Per second (60 * x / reload).
	damagePerSecond: Record<string, number>;
	// Cost to the firer per shot and per second, by channel (energy, heat, fuel, hull, shields, ion, ...).
	firing: Record<string, number>;
	firingPerSecond: Record<string, number>;
}

export interface OutfitData {
	name: string;
	category: string;
	series: string;
	cost: number;
	mass: number;
	attributes: Attributes;
	licenses: string[];
	// Top-level data/ folder where the outfit is first defined (human, hai, wanderer, ...).
	source: string;
	// "gun" or "turret" when it takes a gun port or turret mount.
	slot: "gun" | "turret" | null;
	weapon: WeaponInfo | null;
	// Outfits sold in at least one reachable outfitter.
	sold: boolean;
	// Not sold anywhere, but carried by ships in the game, so it can only be had by plundering them.
	plunderable: boolean;
}

export interface ShipData {
	name: string;
	// Base model name; equal to `name` unless this is a variant.
	model: string;
	category: string;
	cost: number;
	mass: number;
	// Attributes without installed outfits, plus gun ports / turret mounts as the game computes them.
	attributes: Attributes;
	licenses: string[];
	outfits: Record<string, number>;
	gunPorts: number;
	turretMounts: number;
	bays: number;
	source: string;
}

export interface OutfitterData {
	// Outfitter set name -> outfit names.
	sets: Record<string, string[]>;
	// Set names that are attached to at least one planet or have their own location/sell conditions.
	reachable: string[];
}
