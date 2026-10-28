import { type DataNode, numberAt } from "./dataNode.ts";
import type { WeaponInfo } from "./types.ts";

// Mutable accumulation of a `weapon` block. Repeated definitions merge by overwriting
// individual keys (Weapon::Load runs again on a copy of the existing weapon).
export interface RawWeapon {
	scalars: Record<string, number>;
	ammo: { outfit: string; usage: number } | null;
	submunitions: Array<{ outfit: string; count: number }>;
	excludeSubmunitionDamage: boolean;
	homing: boolean;
	disabledDamageSet: boolean;
	relativeDisabledDamageSet: boolean;
}

export function newRawWeapon(): RawWeapon {
	return {
		scalars: {}, ammo: null, submunitions: [], excludeSubmunitionDamage: false,
		homing: false, disabledDamageSet: false, relativeDisabledDamageSet: false,
	};
}

// Keys of the weapon block that are stored as plain numbers (Weapon.cpp:217-400).
const DAMAGE_KEYS = [
	"shield damage", "hull damage", "fuel damage", "heat damage", "energy damage",
	"ion damage", "scrambling damage", "disruption damage", "slowing damage",
	"discharge damage", "corrosion damage", "leak damage", "burn damage",
	"relative shield damage", "relative hull damage", "relative fuel damage",
	"relative heat damage", "relative energy damage",
];
const FIRING_KEYS = [
	"firing energy", "firing heat", "firing fuel", "firing hull", "firing shields",
	"firing ion", "firing scramble", "firing slowing", "firing disruption",
	"firing discharge", "firing corrosion", "firing leak", "firing burn",
	"relative firing energy", "relative firing heat", "relative firing fuel",
	"relative firing hull", "relative firing shields",
];

export function loadWeaponNode(weapon: RawWeapon, node: DataNode): void {
	for(const child of node.children)
	{
		const key = child.tokens[0];
		if(key === "ammo" && child.tokens.length >= 2)
			weapon.ammo = { outfit: child.tokens[1], usage: child.tokens.length >= 3 ? Math.max(0, numberAt(child, 2)) : 1 };
		else if(key === "submunition" && child.tokens.length >= 2)
			weapon.submunitions.push({ outfit: child.tokens[1], count: child.tokens.length >= 3 ? numberAt(child, 2) : 1 });
		else if(key === "exclude submunition damage")
			weapon.excludeSubmunitionDamage = true;
		else if(key === "homing")
			weapon.homing = true;
		else if(child.tokens.length >= 2 && !Number.isNaN(Number(child.tokens[1])))
		{
			weapon.scalars[key] = Number(child.tokens[1]);
			if(key === "disabled damage")
				weapon.disabledDamageSet = true;
		}
	}
}

type WeaponLookup = (outfit: string) => RawWeapon | undefined;

function weaponLifetime(w: RawWeapon, lookup: WeaponLookup, depth = 0): number {
	const velocity = w.scalars["velocity override"] > 0 ? w.scalars["velocity override"] : (w.scalars["velocity"] ?? 0);
	const rangeOverride = w.scalars["range override"] ?? 0;
	if(rangeOverride > 0)
		return velocity > 0 ? rangeOverride / velocity : 0;
	let sub = 0;
	if(depth < 8)
		for(const s of w.submunitions)
		{
			const sw = lookup(s.outfit);
			if(sw)
				sub = Math.max(sub, weaponLifetime(sw, lookup, depth + 1));
		}
	return sub + Math.max(0, w.scalars["lifetime"] ?? 0);
}

// Damage per shot for one channel, adding submunitions (Weapon::TotalDamage).
function channelDamage(w: RawWeapon, key: string, lookup: WeaponLookup, depth = 0): number {
	let total = w.scalars[key] ?? 0;
	if(key === "disabled damage" && !w.disabledDamageSet)
		total = w.scalars["hull damage"] ?? 0;
	if(!w.excludeSubmunitionDamage && depth < 8)
		for(const s of w.submunitions)
		{
			const sw = lookup(s.outfit);
			if(sw)
				total += channelDamage(sw, key, lookup, depth + 1) * s.count;
		}
	return total;
}

export function deriveWeapon(w: RawWeapon, lookup: WeaponLookup): WeaponInfo {
	const reload = Math.max(1, w.scalars["reload"] ?? 1);
	const burstCount = Math.max(1, w.scalars["burst count"] ?? 1);
	const burstReload = Math.min(Math.max(1, w.scalars["burst reload"] ?? 1), reload);
	const velocity = w.scalars["velocity override"] > 0 ? w.scalars["velocity override"] : (w.scalars["velocity"] ?? 0);
	const totalLifetime = weaponLifetime(w, lookup);
	const rangeOverride = w.scalars["range override"] ?? 0;

	const damage: Record<string, number> = {};
	const damagePerSecond: Record<string, number> = {};
	for(const key of DAMAGE_KEYS)
	{
		const value = channelDamage(w, key, lookup);
		if(value)
		{
			const name = key.replace(" damage", "");
			damage[name] = value;
			damagePerSecond[name] = 60 * value / reload;
		}
	}
	const firing: Record<string, number> = {};
	const firingPerSecond: Record<string, number> = {};
	for(const key of FIRING_KEYS)
	{
		const value = w.scalars[key] ?? 0;
		if(value)
		{
			const name = key.replace("firing ", "");
			firing[name] = value;
			firingPerSecond[name] = 60 * value / reload;
		}
	}

	return {
		reload, burstCount, burstReload, totalLifetime,
		range: rangeOverride > 0 ? rangeOverride : velocity * totalLifetime,
		velocity,
		acceleration: w.scalars["acceleration"] ?? 0,
		homing: w.homing,
		instantaneous: totalLifetime === 1,
		antiMissile: Math.max(0, w.scalars["anti-missile"] ?? 0),
		tractorBeam: Math.max(0, w.scalars["tractor beam"] ?? 0),
		missileStrength: Math.max(0, w.scalars["missile strength"] ?? 0),
		ammo: w.ammo,
		damage, damagePerSecond, firing, firingPerSecond,
	};
}
