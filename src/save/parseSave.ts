import { type DataNode, numberAt, parseData } from "../../data-prep/src/dataNode.ts";
import type { Attributes } from "../core/model.ts";
import { type AgeRecord, daysSinceEpoch } from "./depreciation.ts";

export interface SaveShip {
	model: string;
	name: string;
	category: string;
	cost: number;
	mass: number;
	attributes: Attributes; // hull base attributes (no outfits)
	outfits: Record<string, number>;
	planet: string;
	system: string;
}

export interface ShipGroup {
	id: string;
	model: string;
	ships: SaveShip[];
	hull: Attributes;
	hullMass: number;
	hullCost: number;
	outfits: Record<string, number>; // per ship
}

export interface SaveData {
	pilot: string;
	licenses: string[];
	ships: SaveShip[];
	groups: ShipGroup[];
	// outfit name -> total count in planetary storage (summed) and by planet
	storage: Record<string, number>;
	storageByPlanet: Record<string, Record<string, number>>;
	cargo: Record<string, number>;
	visitedPlanets: string[];
	reputation: Record<string, number>; // government -> reputation
	visitedSystems: string[];
	events: string[]; // events that have fired, in order (the "changes" block)
	system: string; // where the pilot is now
	today: number; // current game day, in the same units as the depreciation records
	// Outfit name -> purchase day -> copies, from "fleet depreciation"; used for resale values.
	outfitAges: Record<string, AgeRecord>;
}

const HULL_NON_ATTRIBUTES = new Set(["category", "cost", "mass", "licenses"]);

function readOutfits(node: DataNode | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	for(const c of node?.children ?? [])
		out[c.tokens[0]] = (out[c.tokens[0]] ?? 0) + (c.tokens.length > 1 ? numberAt(c, 1) : 1);
	return out;
}

function child(node: DataNode, key: string): DataNode | undefined {
	return node.children.find(c => c.tokens[0] === key);
}

export function parseSave(text: string): SaveData {
	const nodes = parseData(text);
	const ships: SaveShip[] = [];
	const storageByPlanet: Record<string, Record<string, number>> = {};
	const storage: Record<string, number> = {};
	let cargo: Record<string, number> = {};
	let licenses: string[] = [];
	const visitedPlanets: string[] = [];
	const reputation: Record<string, number> = {};
	const events: string[] = [];
	const visitedSystems: string[] = [];
	let system = "";
	let today = 0;
	const outfitAges: Record<string, AgeRecord> = {};
	let pilot = "";

	for(const node of nodes)
	{
		const key = node.tokens[0];
		if(key === "pilot" && node.tokens.length >= 3)
			pilot = `${node.tokens[1]} ${node.tokens[2]}`;
		else if(key === "ship" && node.tokens.length >= 2)
		{
			const attrNode = child(node, "attributes");
			const attributes: Attributes = {};
			let category = "", cost = 0, mass = 0;
			for(const a of attrNode?.children ?? [])
			{
				const k = a.tokens[0];
				if(k === "category")
					category = a.tokens[1] ?? "";
				else if(k === "cost")
					cost = numberAt(a, 1);
				else if(k === "mass")
					mass = numberAt(a, 1);
				else if(!HULL_NON_ATTRIBUTES.has(k) && a.tokens.length > 1 && !Number.isNaN(Number(a.tokens[1])))
					attributes[k] = Number(a.tokens[1]);
			}
			ships.push({
				model: node.tokens[1],
				name: child(node, "name")?.tokens[1] ?? node.tokens[1],
				category, cost, mass, attributes,
				outfits: readOutfits(child(node, "outfits")),
				planet: child(node, "planet")?.tokens[1] ?? "",
				system: child(node, "system")?.tokens[1] ?? "",
			});
		}
		else if(key === "storage")
		{
			for(const planet of node.children.filter(c => c.tokens[0] === "planet"))
			{
				const outfits = readOutfits(child(child(planet, "cargo") ?? planet, "outfits"));
				const name = planet.tokens[1];
				storageByPlanet[name] = outfits;
				for(const [k, v] of Object.entries(outfits))
					storage[k] = (storage[k] ?? 0) + v;
			}
		}
		else if(key === "cargo")
			cargo = readOutfits(child(node, "outfits"));
		else if(key === "date" && node.tokens.length >= 4)
			today = daysSinceEpoch(numberAt(node, 1), numberAt(node, 2), numberAt(node, 3));
		else if(key === "fleet depreciation")
		{
			for(const record of node.children.filter(c => c.tokens[0] === "outfit" && c.tokens[1]))
				outfitAges[record.tokens[1]] = record.children.map(c => [Number(c.tokens[0]), numberAt(c, 1)] as [number, number]);
		}
		else if(key === "system" && node.tokens[1])
			system = node.tokens[1];
		else if(key === "visited" && node.tokens[1])
			visitedSystems.push(node.tokens[1]);
		else if(key === "visited planet" && node.tokens[1])
			visitedPlanets.push(node.tokens[1]);
		else if(key === "changes")
		{
			for(const c of node.children)
				if(c.tokens[0] === "event" && c.tokens[1])
					events.push(c.tokens[1]);
		}
		else if(key === "reputation with")
		{
			for(const c of node.children)
				reputation[c.tokens[0]] = numberAt(c, 1);
		}
		else if(key === "licenses")
			licenses = node.children.map(c => c.tokens[0]);
	}

	return { pilot, licenses, ships, groups: groupShips(ships), storage, storageByPlanet, cargo, visitedPlanets, reputation, events, visitedSystems, system, today, outfitAges };
}

// Ships of the same model with identical hull attributes and identical outfits share a loadout.
export function groupShips(ships: SaveShip[]): ShipGroup[] {
	const groups = new Map<string, ShipGroup>();
	for(const ship of ships)
	{
		const outfitSig = Object.entries(ship.outfits).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("|");
		const attrSig = Object.entries(ship.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("|");
		const id = `${ship.model}#${hash(attrSig + ship.mass + ship.cost)}#${hash(outfitSig)}`;
		let group = groups.get(id);
		if(!group)
			groups.set(id, group = {
				id, model: ship.model, ships: [], hull: ship.attributes, hullMass: ship.mass,
				hullCost: ship.cost, outfits: ship.outfits,
			});
		group.ships.push(ship);
	}
	return [...groups.values()].sort((a, b) => b.ships.length - a.ships.length || a.model.localeCompare(b.model));
}

function hash(s: string): string {
	let h = 2166136261;
	for(let i = 0; i < s.length; ++i)
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
}
