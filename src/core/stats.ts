import { type EvalResult, type Genome, type Problem, STAT_KEYS } from "./model.ts";

// Formulas follow source/Ship.cpp and source/ship/ShipAttributeCache.cpp.
// Rates: the game runs at 60 frames per second; per-frame attribute values are multiplied by FPS.
const FPS = 60;
const MAX_TEMPERATURE = 100;
// Shield and hull points are the same unit whether they regenerate or are dealt as negative damage
// (DamageProfile hands the negative amount to the shields as-is), so healing per second counts 1:1 as regeneration.
const HEAL_TO_REGEN = 1;
const MIN_PROTECTION = 0.01; // Outfit.cpp keeps shield and hull protection above -0.99
const HEAT_LIMIT = 0.9; // sustainable if steady-state heat stays below this fraction of max heat

const IDX = Object.fromEntries(STAT_KEYS.map((k, i) => [k, i])) as Record<(typeof STAT_KEYS)[number], number>;

export function totals(problem: Problem, g: ArrayLike<number>): { tot: Record<string, number>; mass: number } {
	const tot: Record<string, number> = { ...problem.hull };
	let mass = problem.hullMass;
	const pool = problem.pool;
	for(let i = 0; i < pool.length; ++i)
	{
		const c = g[i];
		if(!c)
			continue;
		const item = pool[i];
		mass += item.mass * c;
		for(const key in item.attrs)
			tot[key] = (tot[key] ?? 0) + item.attrs[key] * c;
	}
	return { tot, mass };
}

export function evaluate(problem: Problem, g: ArrayLike<number>): EvalResult {
	const { adv, constraints: con, pool } = problem;
	const { tot, mass } = totals(problem, g);
	const A = (key: string): number => tot[key] ?? 0;
	const stats = new Float64Array(STAT_KEYS.length);
	let violation = 0;

	// Weapons: per-second damage, firing costs, ammo limits.
	let dps = 0;
	let weaponEnergy = 0; // per second
	let weaponHeat = 0; // per second
	let missileDefence = 0;
	let healShield = 0; // per second, from weapons whose net shield or hull damage is negative
	let healHull = 0;
	let cost = 0;
	let minDriveFuel = Infinity;
	for(let i = 0; i < pool.length; ++i)
	{
		const c = g[i];
		if(!c)
			continue;
		const item = pool[i];
		cost += item.cost * c;
		if(item.attrs["hyperdrive"] || item.attrs["scram drive"])
			minDriveFuel = Math.min(minDriveFuel, item.attrs["hyperdrive fuel"] ?? 100);
		if(item.attrs["jump drive"])
			minDriveFuel = Math.min(minDriveFuel, item.attrs["jump drive fuel"] ?? 200);
		const w = item.weapon;
		if(!w)
			continue;
		if(w.antiMissile > 0)
		{
			missileDefence += c * w.antiMissile * FPS / w.reload;
			weaponEnergy += c * (w.firingPerSecond["energy"] ?? 0);
			weaponHeat += c * (w.firingPerSecond["heat"] ?? 0);
			continue;
		}
		if(w.tractorBeam > 0)
			continue;
		const d = w.damagePerSecond;
		// Negative net damage heals the target (DamageProfile applies it as-is), so it counts as repair, not offence.
		const shieldDamage = d["shield"] ?? 0, hullDamage = d["hull"] ?? 0;
		let value = (Math.max(0, shieldDamage) + Math.max(0, hullDamage)) / 2
			+ 100 * ((d["ion"] ?? 0) * adv.ion + (d["disruption"] ?? 0) * adv.disruption
				+ (d["slowing"] ?? 0) * adv.slowing + (d["scrambling"] ?? 0) * adv.scrambling);
		let fireShare = 1;
		if(w.ammo)
		{
			// Rounds available per launcher vs. the time they last at full fire rate.
			const rounds = item.ammoIdx >= 0 ? g[item.ammoIdx] : 0;
			const shotsPerSecond = c * w.ammo.usage * FPS / w.reload;
			const lasts = shotsPerSecond > 0 ? rounds / shotsPerSecond : 0;
			fireShare = Math.min(1, lasts / adv.ammoHorizon);
		}
		value *= c * fireShare;
		dps += value;
		healShield += c * fireShare * Math.max(0, -shieldDamage);
		healHull += c * fireShare * Math.max(0, -hullDamage);
		weaponEnergy += c * fireShare * (w.firingPerSecond["energy"] ?? 0);
		weaponHeat += c * fireShare * (w.firingPerSecond["heat"] ?? 0);
	}

	// Energy: generation vs non-weapon draw, batteries cover a short deficit.
	const moveEnergy = adv.moveDuty * (A("thrusting energy") + A("turning energy"));
	const baseDraw = A("energy consumption") + moveEnergy + A("shield energy") + A("hull energy");
	const surplus = FPS * (A("energy generation") + 0.5 * A("solar collection") - baseDraw);
	const budget = surplus + A("energy capacity") / adv.batteryHorizon;
	const fEnergy = weaponEnergy > 0 ? clamp01(budget / weaponEnergy) : 1;

	// Heat: steady-state heat = production / (dissipation + active cooling / max heat) (Ship::IdleHeat).
	const x = A("cooling inefficiency");
	const eff = x ? 2 + 2 / (1 + Math.exp(-x / 2)) - 4 / (1 + Math.exp(-x / 4)) : 1;
	const maxHeat = MAX_TEMPERATURE * (mass + A("heat capacity"));
	const dissipation = 0.001 * A("heat dissipation") + eff * A("active cooling") / maxHeat;
	const moveHeat = adv.moveDuty * (A("thrusting heat") + A("turning heat"));
	const baseHeat = FPS * (A("heat generation") + moveHeat + A("shield heat") + A("hull heat") - eff * A("cooling"));
	const heatBudget = HEAT_LIMIT * maxHeat * dissipation * FPS - baseHeat; // heat/s we can still add
	const fHeat = weaponHeat > 0 ? clamp01(heatBudget / weaponHeat) : (heatBudget >= 0 ? 1 : 0);

	const fire = Math.min(fEnergy, fHeat);
	stats[IDX.offence] = dps * fire;
	if(con.positiveEnergy && fEnergy < 1 && weaponEnergy > 0)
		violation += 1 - fEnergy;
	if(con.heatSustainable && fHeat < 1)
		violation += 1 - fHeat;

	// Defence.
	stats[IDX.shieldRegen] = FPS * (A("shield generation") + A("delayed shield generation")) * (1 + A("shield generation multiplier"))
		+ HEAL_TO_REGEN * healShield * fire;
	stats[IDX.hullRepair] = FPS * (A("hull repair rate") + A("delayed hull repair rate")) * (1 + A("hull repair multiplier"))
		+ HEAL_TO_REGEN * healHull * fire;
	// Incoming damage is divided by 1 + protection (Entity::Recalibrate), so this is the factor on effective HP.
	stats[IDX.shieldProtection] = Math.max(MIN_PROTECTION, 1 + A("shield protection"));
	stats[IDX.hullProtection] = Math.max(MIN_PROTECTION, 1 + A("hull protection"));
	stats[IDX.missileDefence] = missileDefence;
	stats[IDX.heatTolerance] = Math.max(0, heatBudget);
	stats[IDX.energyReserve] = A("energy capacity") + Math.max(0, surplus) * 10;

	// Movement (Ship::TurnRate / Acceleration / MaxVelocity / Drag).
	const inertial = mass / (1 + A("inertia reduction"));
	const rawDrag = A("drag") / (1 + A("drag reduction"));
	const drag = Math.min(rawDrag, inertial) || 1;
	const thrust = A("thrust") || A("afterburner thrust");
	stats[IDX.turning] = A("turn") / inertial * (1 + A("turn multiplier")) * FPS;
	stats[IDX.thrust] = thrust / inertial * (1 + A("acceleration multiplier")) * FPS * FPS;
	stats[IDX.maxSpeed] = (thrust + (A("thrust") ? A("afterburner thrust") : 0)) / drag * FPS;

	// Ship::FlightCheck: the errors that stop takeoff and the warnings the outfitter shows. A loadout that trips any of
	// them is rejected whatever the weights and the "ignore ... when firing" options say.
	const idleEnergy = A("energy generation") - A("energy consumption") + A("fuel energy") + A("solar collection");
	const totalEnergy = idleEnergy + A("energy capacity");
	const thrustEnergy = A("thrusting energy"), turnEnergy = A("turning energy");
	const idleProduction = Math.max(0, A("heat generation") - eff * A("cooling")); // Ship::IdleHeat, per frame
	const fuelBalance = A("fuel capacity") + A("fuel generation") - A("fuel consumption");
	if(!A("thrust")) // no thruster; afterburner-only and reverse-only are warnings
		violation += 1;
	if(!A("turn")) // no steering
		violation += 1;
	if(idleProduction >= maxHeat * dissipation) // overheating
		violation += 1;
	if(totalEnergy <= 0) // no energy
		violation += 1;
	if(totalEnergy - A("fuel energy") <= 0 && fuelBalance <= 0) // no fuel
		violation += 1;
	if(idleEnergy <= 0) // battery only
		violation += 0.5;
	if(totalEnergy < thrustEnergy || totalEnergy < turnEnergy || totalEnergy < thrustEnergy + turnEnergy) // limited thrust, turn or movement
		violation += 0.5;
	if(totalEnergy - 0.8 * A("solar collection") < 0.2 * (thrustEnergy + turnEnergy)) // solar power
		violation += 0.5;
	if(idleProduction <= 0 && (A("thrusting heat") < 0 || A("turning heat") < 0)) // insufficient heat
		violation += 0.5;
	if(fuelBalance < 0) // fuel
		violation += 0.5;
	if(minDriveFuel < Infinity && A("fuel capacity") < minDriveFuel) // not enough fuel for one jump
		violation += 0.5;
	for(let i = 0; i < pool.length; ++i)
		if(g[i] && (pool[i].weapon?.firing["energy"] ?? 0) > totalEnergy) // insufficient energy to fire
		{
			violation += 0.5;
			break;
		}

	// Crew, fuel, cargo, cost.
	const automaton = A("automaton") > 0;
	const required = (automaton ? 0 : Math.max(1, A("required crew"))) + A("mandatory crew");
	stats[IDX.spareCrew] = A("bunks") - required;
	stats[IDX.jumps] = minDriveFuel < Infinity ? A("fuel capacity") / minDriveFuel : 0;
	stats[IDX.fuelCapacity] = A("fuel capacity");
	// Generators add "fuel generation" per frame. A ramscoop gathers 0.03 * sqrt(ramscoop) per frame near a star
	// (System::GetSolarGeneration with a typical star wind and distance scale of 1), so this is an estimate.
	stats[IDX.fuelRegen] = FPS * (A("fuel generation") + 0.03 * Math.sqrt(Math.max(0, A("ramscoop"))));
	stats[IDX.cargo] = A("cargo space");
	stats[IDX.cost] = cost;

	if(con.requireHyperdrive && !(A("hyperdrive") > 0 || A("scram drive") > 0))
		violation += 1;
	if(con.requireJumpDrive && !(A("jump drive") > 0))
		violation += 1;
	for(const attribute of con.requiredAttributes)
		if(!(A(attribute) > 0))
			violation += 1;
	if(con.minFuel > 0 && A("fuel capacity") < con.minFuel)
		violation += (con.minFuel - A("fuel capacity")) / con.minFuel;
	if(con.minCargo > 0 && A("cargo space") < con.minCargo)
		violation += (con.minCargo - A("cargo space")) / con.minCargo;
	if(con.minBunks > 0 && stats[IDX.spareCrew] < con.minBunks)
		violation += (con.minBunks - stats[IDX.spareCrew]) / con.minBunks;
	if(stats[IDX.spareCrew] < 0)
		violation += 0.25; // not enough bunks to crew the ship

	// Capacity constraints are normally enforced by repair; report leftovers defensively.
	for(let k = 0; k < problem.capKeys.length; ++k)
	{
		const left = problem.hullCap[k] + capSum(problem, g, k);
		if(left < 0)
			violation += 10 + -left;
	}
	return { stats, violation };
}

export function capSum(problem: Problem, g: ArrayLike<number>, k: number): number {
	let sum = 0;
	for(let i = 0; i < problem.pool.length; ++i)
		if(g[i])
			sum += problem.pool[i].cap[k] * g[i];
	return sum;
}

function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

export type { Genome };
