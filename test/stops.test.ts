import { test } from "node:test";
import assert from "node:assert/strict";
import { type MapData, applyEvents, landablePlanets, pathFromVisible, planStops, unshroudedPlanets } from "../src/core/stops.ts";

const map: MapData = {
	systems: {
		Sol: { pos: [0, 0], links: ["Near", "Far"], planets: ["Earth"] },
		Near: { pos: [10, 0], links: [], planets: ["Nearby"] },
		Far: { pos: [100, 0], links: [], planets: ["Faraway", "Moon"] },
	},
	planetSets: { Earth: ["A"], Nearby: ["B"], Faraway: ["All"], Moon: ["B"] },
	landing: {}, events: {}, requires: [],
};
const sets = { A: ["w1"], B: ["w2"], All: ["w1", "w2", "w3", "w4", "w5"] };
const buy = ["w1", "w2", "w3", "w4", "w5"].map(name => ({ name, count: 1, cost: 10 }));

test("five outfits sold at one outfitter need one stop", () => {
	const plan = planStops(buy, map, sets, ["Earth", "Nearby", "Faraway", "Moon"]);
	assert.equal(plan.stops.length, 1);
	assert.equal(plan.stops[0].system, "Far");
	assert.equal(plan.stops[0].planets[0].items.length, 5);
	assert.deepEqual(plan.unplaced, []);
});

test("only visited planets count, and unsold items are reported", () => {
	const plan = planStops(buy, map, sets, ["Earth", "Nearby"]);
	assert.deepEqual(plan.stops.map(s => s.system), ["Sol", "Near"]);
	assert.deepEqual(plan.unplaced.map(u => u.name), ["w3", "w4", "w5"]);
});

test("ties go to the system closest to Sol", () => {
	const plan = planStops([{ name: "w2", count: 1, cost: 1 }], map, sets, ["Moon", "Nearby"]);
	assert.deepEqual(plan.stops.map(s => s.system), ["Near"]);
});

test("landablePlanets keeps only planets the reputation reaches or a bribe opens", () => {
	const landing = {
		Open: { government: "G", requiredReputation: 0, bribe: 0, bribeThreshold: 0 },
		Friendly: { government: "G", requiredReputation: 10, bribe: 0, bribeThreshold: 0 },
		Strict: { government: "G", requiredReputation: 50, bribe: 0, bribeThreshold: 0 },
		Bribable: { government: "G", requiredReputation: 50, bribe: 0.1, bribeThreshold: 0 },
	};
	const withLanding: MapData = { ...map, landing };
	assert.deepEqual(landablePlanets(["Open", "Friendly", "Strict", "Bribable", "Unknown"], withLanding, { G: 10 }),
		["Open", "Friendly", "Bribable", "Unknown"]);
});

test("applyEvents replays outfitter and link changes of fired events only", () => {
	const withEvents: MapData = {
		...map,
		events: {
			razed: { planets: { Faraway: [["clearSets", null]] }, systems: { Near: [["link", "Far"]] } },
			later: { planets: { Moon: [["addSet", "A"]] }, systems: {} },
		},
	};
	const after = applyEvents(withEvents, ["razed"]);
	assert.deepEqual(after.planetSets["Faraway"], []);
	assert.deepEqual(after.planetSets["Moon"], ["B"]);
	assert.deepEqual(after.systems["Near"].links, ["Far"]);
	assert.deepEqual(withEvents.planetSets["Faraway"], ["All"]);
});

test("unshroudedPlanets drops planets in shrouded systems", () => {
	const shrouded: MapData = { ...map, systems: { ...map.systems, Far: { ...map.systems["Far"], shrouded: true } } };
	assert.deepEqual(unshroudedPlanets(["Earth", "Nearby", "Faraway", "Moon"], shrouded), ["Earth", "Nearby"]);
});

test("pathFromVisible walks hyperlanes from the nearest visited, unshrouded system", () => {
	const chain: MapData = {
		...map,
		systems: {
			A: { pos: [0, 0], links: ["B"], planets: [] },
			B: { pos: [1, 0], links: ["C"], planets: [], shrouded: true },
			C: { pos: [2, 0], links: [], planets: [], shrouded: true },
		},
	};
	assert.deepEqual(pathFromVisible(chain, "C", ["A", "B"]), ["A", "B", "C"]);
	assert.equal(pathFromVisible(chain, "C", []), null);
});
