import { resaleValue } from "../save/depreciation.ts";
import type { SaveData, ShipGroup } from "../save/parseSave.ts";
import type { Genome, Problem } from "./model.ts";

export interface ShoppingLine {
	name: string;
	perShip: number; // count in the new loadout
	change: number; // new - current, per ship
	total: number; // extra copies needed across the group (0 when removing)
	fromInstalled: number; // freed up by outfits removed from this group
	fromStorage: Array<{ planet: string; count: number }>;
	fromCargo: number;
	toBuy: number;
	buyCost: number;
	plunderShort: number; // copies still missing and not purchasable
}

// Where each outfit of the new loadout comes from, for the whole group (count per ship x ships).
export function shoppingList(
	problem: Problem, genome: Genome, group: ShipGroup, save: SaveData, buyable: Set<string>,
): ShoppingLine[] {
	const n = group.ships.length;
	const lines: ShoppingLine[] = [];
	// Outfits freed by this group's removals can be reused for additions of the same outfit... only the same name.
	for(let i = 0; i < problem.pool.length; ++i)
	{
		const item = problem.pool[i];
		const current = group.outfits[item.name] ?? 0;
		const target = genome[i];
		if(target <= current)
			continue;
		let need = (target - current) * n;
		const line: ShoppingLine = {
			name: item.name, perShip: target, change: target - current, total: need, fromInstalled: 0,
			fromStorage: [], fromCargo: 0, toBuy: 0, buyCost: 0, plunderShort: 0,
		};
		for(const [planet, outfits] of Object.entries(save.storageByPlanet))
		{
			const have = Math.min(need, outfits[item.name] ?? 0);
			if(have > 0)
			{
				line.fromStorage.push({ planet, count: have });
				need -= have;
			}
		}
		const cargo = Math.min(need, save.cargo[item.name] ?? 0);
		line.fromCargo = cargo;
		need -= cargo;
		if(need > 0)
		{
			if(buyable.has(item.name))
			{
				line.toBuy = need;
				line.buyCost = need * item.cost;
			}
			else
				line.plunderShort = need;
		}
		lines.push(line);
	}
	return lines.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResaleLine {
	name: string;
	count: number; // copies freed across the group
	value: number; // credits for selling them, after depreciation
}

// Outfits the new loadout takes off the group's ships, with what the game would pay for them (fleet depreciation).
export function resaleList(problem: Problem, genome: Genome, group: ShipGroup, save: SaveData): ResaleLine[] {
	const n = group.ships.length;
	const lines: ResaleLine[] = [];
	for(let i = 0; i < problem.pool.length; ++i)
	{
		const item = problem.pool[i];
		const freed = ((group.outfits[item.name] ?? 0) - genome[i]) * n;
		if(freed > 0)
			lines.push({ name: item.name, count: freed, value: resaleValue(save.outfitAges[item.name], item.cost, freed, save.today) });
	}
	return lines.sort((a, b) => a.name.localeCompare(b.name));
}
