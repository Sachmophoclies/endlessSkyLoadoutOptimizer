import type { PlunderData, PlunderSource } from "../../data-prep/src/types.ts";

// "Korath (Civilian)" and "Korath" are the same people to the player, so sources are shown by the name before the bracket.
export const raceOf = (government: string): string => government.replace(/\s*\(.*\)$/, "");

const reputationWith = (government: string, reputation: Record<string, number>, plunder: PlunderData): number =>
	reputation[government] ?? plunder.reputation[government] ?? 0;

// Hostile: the government's reputation toward the player is below zero, so its ships can be fought freely.
export function hostileSource(name: string, reputation: Record<string, number>, plunder: PlunderData | null): boolean {
	return !!plunder && (plunder.sources[name] ?? []).some(s => reputationWith(s.government, reputation, plunder) < 0);
}

export interface PlunderRace {
	race: string;
	categories: string[];
	ships: string[];
	hostile: boolean;
}

// Where an outfit can be plundered, merged by race.
export function plunderRaces(name: string, reputation: Record<string, number>, plunder: PlunderData | null): PlunderRace[] {
	if(!plunder)
		return [];
	const merged = new Map<string, { categories: Set<string>; ships: Set<string>; hostile: boolean }>();
	for(const s of plunder.sources[name] ?? [] as PlunderSource[])
	{
		const race = raceOf(s.government);
		const entry = merged.get(race) ?? { categories: new Set<string>(), ships: new Set<string>(), hostile: false };
		merged.set(race, entry);
		s.categories.forEach(c => entry.categories.add(c));
		s.ships.forEach(c => entry.ships.add(c));
		entry.hostile ||= reputationWith(s.government, reputation, plunder) < 0;
	}
	return [...merged].map(([race, e]) => ({ race, categories: [...e.categories].sort(), ships: [...e.ships].sort(), hostile: e.hostile }))
		.sort((a, b) => Number(b.hostile) - Number(a.hostile) || a.race.localeCompare(b.race));
}
