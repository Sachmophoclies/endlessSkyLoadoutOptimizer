import type { OutfitData } from "../../data-prep/src/types.ts";
import type { SaveData } from "../save/parseSave.ts";

// Real faction folders only: top-level files (harvesting.txt, persons.txt) and "_deprecated" hold non-buildable items.
export const isGameSource = (s: string): boolean => !s.startsWith("_") && !s.endsWith(".txt");

// Sources that are never offered by default, whatever the save holds (Quarg outfits are never for sale).
const NEVER_DEFAULT = new Set(["quarg"]);

export interface SourceAccess {
	visitedSellers: number; // visited planets whose outfitter sells something from this source
	owned: boolean; // the save holds an outfit from this source (installed, in storage or in cargo)
}

// What the player has actually reached: planets in the save's "visited planet" list that sell the source's outfits
// (planetSources comes from `outfitter` lines on planets in the game data), and outfits already held.
export function sourceAccess(save: SaveData, outfits: OutfitData[], planetSources: Record<string, string[]>): Map<string, SourceAccess> {
	const result = new Map<string, SourceAccess>();
	const entry = (s: string): SourceAccess => result.get(s) ?? result.set(s, { visitedSellers: 0, owned: false }).get(s)!;
	for(const planet of new Set(save.visitedPlanets))
		for(const source of planetSources[planet] ?? [])
			++entry(source).visitedSellers;
	const sourceOf = new Map(outfits.map(o => [o.name, o.source]));
	const held = new Set<string>([...Object.keys(save.storage), ...Object.keys(save.cargo)]);
	for(const ship of save.ships)
		Object.keys(ship.outfits).forEach(name => held.add(name));
	for(const name of held)
	{
		const source = sourceOf.get(name);
		if(source)
			entry(source).owned = true;
	}
	return result;
}

export function defaultSources(access: Map<string, SourceAccess>): Set<string> {
	const out = new Set<string>();
	for(const [source, a] of access)
		if(isGameSource(source) && !NEVER_DEFAULT.has(source) && (a.visitedSellers > 0 || a.owned))
			out.add(source);
	return out;
}
