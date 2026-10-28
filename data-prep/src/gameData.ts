import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type DataNode, parseData, numberAt } from "./dataNode.ts";
import { type RawWeapon, deriveWeapon, loadWeaponNode, newRawWeapon } from "./weapons.ts";
import type { Attributes, OutfitData, OutfitterData, ShipData } from "./types.ts";

// Defaults from Outfit.h.
const DEFAULT_HYPERDRIVE_COST = 100;
const DEFAULT_SCRAM_DRIVE_COST = 150;
const DEFAULT_JUMP_DRIVE_COST = 200;

// Mutable outfit-like record, loaded by Outfit::Load. Used for outfits and for ship `attributes` blocks.
interface RawOutfit {
	name: string;
	category: string;
	series: string;
	cost: number;
	mass: number;
	attributes: Attributes;
	licenses: Set<string>;
	weapon: RawWeapon | null;
	source: string;
}

interface RawShip {
	name: string;
	model: string;
	isVariant: boolean;
	source: string;
	attributes: RawOutfit;
	addAttributes: RawOutfit | null;
	outfits: Record<string, number> | null;
	gunCount: number;
	turretCount: number;
	hasHardpointPoints: boolean;
	bays: number;
}

function newRawOutfit(name: string, source: string): RawOutfit {
	return { name, category: "", series: "", cost: 0, mass: 0, attributes: {}, licenses: new Set(), weapon: null, source };
}

// Mirrors Outfit::Load (Outfit.cpp:294): known keys first, any other `key value` is a numeric attribute.
function loadOutfitNode(outfit: RawOutfit, node: DataNode): void {
	for(const child of node.children)
	{
		const key = child.tokens[0];
		const hasValue = child.tokens.length >= 2;
		if(key === "category" && hasValue)
			outfit.category = child.tokens[1];
		else if(key === "series" && hasValue)
			outfit.series = child.tokens[1];
		else if(key === "weapon")
		{
			outfit.weapon ??= newRawWeapon();
			loadWeaponNode(outfit.weapon, child);
		}
		else if(key === "cost" && hasValue)
			outfit.cost = numberAt(child, 1);
		else if(key === "mass" && hasValue)
			outfit.mass = numberAt(child, 1);
		else if(key === "licenses" && (child.children.length > 0 || hasValue))
		{
			for(const token of child.tokens.slice(1))
				outfit.licenses.add(token);
			for(const grand of child.children)
				outfit.licenses.add(grand.tokens[0]);
		}
		else if(hasValue && !NON_ATTRIBUTE_KEYS.has(key) && !Number.isNaN(Number(child.tokens[1])))
			outfit.attributes[key] = Number(child.tokens[1]);
	}

	const a = outfit.attributes;
	const jumpFuel = a["jump fuel"] ?? 0;
	if((a["hyperdrive"] || a["scram drive"]) && !((a["hyperdrive fuel"] ?? 0) > 0))
		a["hyperdrive fuel"] = jumpFuel > 0 ? jumpFuel : (a["scram drive"] ? DEFAULT_SCRAM_DRIVE_COST : DEFAULT_HYPERDRIVE_COST);
	if(a["jump drive"] && !((a["jump drive fuel"] ?? 0) > 0))
		a["jump drive fuel"] = jumpFuel > 0 ? jumpFuel : DEFAULT_JUMP_DRIVE_COST;
	if(jumpFuel)
		delete a["jump fuel"];
}

// Keys handled specially by Outfit::Load (or art/sound only) that must never become attributes.
const NON_ATTRIBUTE_KEYS = new Set([
	"display name", "plural", "index", "thumbnail", "description", "flare sprite", "reverse flare sprite",
	"steering flare sprite", "flare sound", "reverse flare sound", "steering flare sound", "afterburner effect",
	"jump effect", "hyperdrive sound", "hyperdrive in sound", "hyperdrive out sound", "jump sound",
	"jump in sound", "jump out sound", "cargo scan sound", "outfit scan sound", "flotsam sprite", "ammo", "linked",
]);

export interface MapSystem {
	pos: [number, number];
	links: string[];
	planets: string[]; // named `object`s at any depth; these are planet (or station) names
}

export interface GameData {
	outfits: Map<string, OutfitData>;
	ships: Map<string, ShipData>;
	outfitters: OutfitterData;
	// Planet -> outfit sources sold there. Only `outfitter` lines written directly on a planet count;
	// sets added by events or missions are conditional and are left out.
	planetSources: Record<string, string[]>;
	// Star map for trip planning, and the outfitter sets written directly on each planet.
	// `requires`: ship attributes that planets demand before a ship may land ("requires: <attribute>", Planet.cpp).
	map: { systems: Record<string, MapSystem>; planetSets: Record<string, string[]>; requires: string[] };
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for(const name of readdirSync(dir).sort())
	{
		const path = join(dir, name);
		if(statSync(path).isDirectory())
			out.push(...listFiles(path));
		else if(name.endsWith(".txt"))
			out.push(path);
	}
	return out;
}

export function loadGameData(dataDir: string): GameData {
	const outfits = new Map<string, RawOutfit>();
	const ships = new Map<string, RawShip>();
	const sets = new Map<string, Set<string>>();
	const setsWithConditions = new Set<string>();
	const planetSets = new Set<string>();
	const staticPlanetSets = new Map<string, string[]>();
	const systems: Record<string, MapSystem> = {};
	const requires = new Set<string>();

	for(const file of listFiles(dataDir))
	{
		const source = relative(dataDir, file).split(sep)[0];
		const nodes = parseData(readFileSync(file, "utf8"));
		for(const node of nodes)
		{
			const key = node.tokens[0];
			if(key === "outfit" && node.tokens.length >= 2)
			{
				const name = node.tokens[1];
				let outfit = outfits.get(name);
				if(!outfit)
					outfits.set(name, outfit = newRawOutfit(name, source));
				loadOutfitNode(outfit, node);
			}
			else if(key === "ship" && node.tokens.length >= 2)
				loadShipNode(ships, node, source);
			else if(key === "outfitter" && node.tokens.length >= 2)
				loadOutfitterNode(sets, setsWithConditions, node);
			else if(key === "system" && node.tokens.length >= 2)
				systems[node.tokens[1]] = readSystem(node);
			else if(key === "planet" || key === "event")
			{
				collectPlanetOutfitters(node, planetSets);
				collectRequirements(node, requires);
				if(key === "planet" && node.tokens.length >= 2)
					for(const c of node.children)
						if(c.tokens[0] === "outfitter" && c.tokens[1])
							staticPlanetSets.set(node.tokens[1], [...(staticPlanetSets.get(node.tokens[1]) ?? []), c.tokens[1]]);
			}
		}
	}

	const planetSources: Record<string, string[]> = {};
	for(const [planet, setNames] of staticPlanetSets)
	{
		const found = new Set<string>();
		for(const setName of setNames)
			for(const item of sets.get(setName) ?? [])
			{
				const outfit = outfits.get(item);
				if(outfit?.category)
					found.add(outfit.source);
			}
		if(found.size)
			planetSources[planet] = [...found].sort();
	}

	return {
		planetSources,
		map: { systems, planetSets: Object.fromEntries(staticPlanetSets), requires: [...requires].sort() },
		outfits: finishOutfits(outfits, sets, setsWithConditions, planetSets),
		ships: finishShips(ships),
		outfitters: {
			sets: Object.fromEntries([...sets].map(([name, items]) => [name, [...items]])),
			reachable: [...sets.keys()].filter(name => setsWithConditions.has(name) || planetSets.has(name)),
		},
	};
}

function loadShipNode(ships: Map<string, RawShip>, node: DataNode, source: string): void {
	// `ship "Model"` defines a model; `ship "Model" "Variant"` is stored under the variant name.
	const model = node.tokens[1];
	const isVariant = node.tokens.length > 2;
	const name = isVariant ? node.tokens[2] : model;
	let ship = ships.get(name);
	if(!ship)
		ships.set(name, ship = {
			name, model, isVariant, source, attributes: newRawOutfit(name, source), addAttributes: null,
			outfits: null, gunCount: 0, turretCount: 0, hasHardpointPoints: false, bays: 0,
		});

	let seenHardpoints = false;
	for(const child of node.children)
	{
		const key = child.tokens[0];
		if(key === "attributes")
			loadOutfitNode(ship.attributes, child);
		else if(key === "add" && child.tokens[1] === "attributes")
			loadOutfitNode(ship.addAttributes ??= newRawOutfit(name, source), child);
		else if(key === "gun" || key === "turret")
		{
			// The first hardpoint line replaces any hardpoints from an earlier definition (hasArmament).
			if(!seenHardpoints)
			{
				seenHardpoints = true;
				ship.gunCount = ship.turretCount = 0;
				ship.hasHardpointPoints = false;
			}
			if(key === "gun")
				++ship.gunCount;
			else
				++ship.turretCount;
			if(child.tokens.length >= 3)
				ship.hasHardpointPoints = true;
		}
		else if(key === "fighter" || key === "drone" || key === "bay")
			++ship.bays;
		else if(key === "outfits")
		{
			ship.outfits = {};
			for(const grand of child.children)
			{
				const count = grand.tokens.length >= 2 ? numberAt(grand, 1) : 1;
				if(count > 0)
					ship.outfits[grand.tokens[0]] = (ship.outfits[grand.tokens[0]] ?? 0) + count;
			}
		}
	}
}

function loadOutfitterNode(sets: Map<string, Set<string>>, withConditions: Set<string>, node: DataNode): void {
	const name = node.tokens[1];
	let items = sets.get(name);
	if(!items)
		sets.set(name, items = new Set());
	// Sale::LoadSingle: bare names insert; `add X` inserts; `remove X` erases; `clear`/`remove` empties.
	// `stock` blocks hold plain names (modifiers are not allowed inside them).
	const loadItem = (child: DataNode, inStock: boolean): void => {
		const token = child.tokens[0];
		const hasValue = child.tokens.length >= 2;
		if(!inStock && (token === "remove" || token === "clear"))
		{
			if(hasValue)
				items.delete(child.tokens[1]);
			else
				items.clear();
		}
		else if(!inStock && token === "add" && hasValue)
			items.add(child.tokens[1]);
		else
			items.add(token);
	};
	for(const child of node.children)
	{
		const key = child.tokens[0] === "add" || child.tokens[0] === "remove" ? child.tokens[1] : child.tokens[0];
		if(key === "location" || (key === "to" && child.tokens.includes("sell")))
			withConditions.add(name);
		else if(key === "stock" && (child.tokens[0] === "stock" || child.tokens[0] === "add"))
			child.children.forEach(grand => loadItem(grand, true));
		else
			loadItem(child, false);
	}
}

// Planets (and events that modify them) reference outfitter sets with `outfitter "Set"` / `add outfitter "Set"`.
function collectPlanetOutfitters(node: DataNode, out: Set<string>): void {
	const walk = (n: DataNode, inPlanet: boolean): void => {
		const [first, second, third] = n.tokens;
		if(inPlanet && first === "outfitter" && second)
			out.add(second);
		else if(inPlanet && first === "add" && second === "outfitter" && third)
			out.add(third);
		const nowInPlanet = inPlanet || n.tokens[0] === "planet";
		for(const c of n.children)
			walk(c, nowInPlanet);
	};
	walk(node, false);
}

function finishOutfits(
	raw: Map<string, RawOutfit>, sets: Map<string, Set<string>>,
	withConditions: Set<string>, planetSets: Set<string>,
): Map<string, OutfitData> {
	const reachable = new Set<string>();
	for(const [name, items] of sets)
		if(withConditions.has(name) || planetSets.has(name))
			items.forEach(item => reachable.add(item));

	const lookup = (name: string): RawWeapon | undefined => raw.get(name)?.weapon ?? undefined;
	const result = new Map<string, OutfitData>();
	for(const [name, outfit] of raw)
	{
		// Pseudo-outfits (submunitions, explosion weapons) have no category and are not installable.
		if(!outfit.category)
			continue;
		const a = outfit.attributes;
		result.set(name, {
			name,
			category: outfit.category,
			series: outfit.series,
			cost: outfit.cost,
			mass: outfit.mass,
			attributes: a,
			licenses: [...outfit.licenses],
			source: outfit.source,
			slot: (a["gun ports"] ?? 0) < 0 ? "gun" : (a["turret mounts"] ?? 0) < 0 ? "turret" : null,
			weapon: outfit.weapon ? deriveWeapon(outfit.weapon, lookup) : null,
			sold: reachable.has(name),
		});
	}
	return result;
}

// Ship::FinishLoading (Ship.cpp:917): variants inherit from their model when they omit pieces.
function finishShips(raw: Map<string, RawShip>): Map<string, ShipData> {
	const result = new Map<string, ShipData>();
	for(const ship of raw.values())
	{
		const base = ship.isVariant ? raw.get(ship.model) : undefined;
		const own = ship.attributes;
		const hasOwnAttributes = Object.keys(own.attributes).length > 0 || own.category !== "" || own.cost > 0;
		const source = hasOwnAttributes || !base ? own : base.attributes;
		if(!source.category && Object.keys(source.attributes).length === 0)
			continue;

		const attributes: Attributes = { ...source.attributes };
		const licenses = new Set(source.licenses);
		let cost = source.cost;
		let mass = source.mass;

		// Hardpoint counts: a variant that lists no hardpoint coordinates (and no outfit overrides) uses its model's.
		let gunPorts = ship.gunCount;
		let turretMounts = ship.turretCount;
		let bays = ship.bays;
		const inheritsOutfits = ship.outfits === null || Object.keys(ship.outfits).length === 0;
		if(base)
		{
			if(!ship.hasHardpointPoints && (inheritsOutfits || ship.gunCount + ship.turretCount === 0))
			{
				gunPorts = base.gunCount;
				turretMounts = base.turretCount;
			}
			if(bays === 0)
				bays = base.bays;
		}
		attributes["gun ports"] = gunPorts;
		attributes["turret mounts"] = turretMounts;
		if(source.category === "Drone" && !attributes["automaton"])
			attributes["automaton"] = 1;

		if(ship.addAttributes)
		{
			for(const [key, value] of Object.entries(ship.addAttributes.attributes))
				attributes[key] = (attributes[key] ?? 0) + value;
			ship.addAttributes.licenses.forEach(l => licenses.add(l));
			cost += ship.addAttributes.cost;
			mass += ship.addAttributes.mass;
		}

		result.set(ship.name, {
			name: ship.name,
			model: ship.model,
			category: source.category,
			cost, mass, attributes,
			licenses: [...licenses],
			outfits: inheritsOutfits && base?.outfits ? { ...base.outfits } : { ...(ship.outfits ?? {}) },
			gunPorts, turretMounts, bays,
			source: ship.source,
		});
	}
	return result;
}

function readSystem(node: DataNode): MapSystem {
	const system: MapSystem = { pos: [0, 0], links: [], planets: [] };
	for(const child of node.children)
	{
		if(child.tokens[0] === "pos" && child.tokens.length >= 3)
			system.pos = [numberAt(child, 1), numberAt(child, 2)];
		else if(child.tokens[0] === "link" && child.tokens[1])
			system.links.push(child.tokens[1]);
		else if(child.tokens[0] === "object")
			collectObjects(child, system.planets);
	}
	return system;
}

function collectObjects(node: DataNode, out: string[]): void {
	if(node.tokens[1])
		out.push(node.tokens[1]);
	for(const child of node.children)
		if(child.tokens[0] === "object")
			collectObjects(child, out);
}

const REQUIRES_PREFIX = "requires: ";

function collectRequirements(node: DataNode, out: Set<string>): void {
	for(const token of node.tokens)
		if(token.startsWith(REQUIRES_PREFIX))
			out.add(token.slice(REQUIRES_PREFIX.length));
	node.children.forEach(child => collectRequirements(child, out));
}
