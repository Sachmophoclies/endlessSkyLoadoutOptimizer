import { test } from "node:test";
import assert from "node:assert/strict";
import { type MapData, planStops } from "../src/core/stops.ts";

const map: MapData = {
	systems: {
		Sol: { pos: [0, 0], links: ["Near", "Far"], planets: ["Earth"] },
		Near: { pos: [10, 0], links: [], planets: ["Nearby"] },
		Far: { pos: [100, 0], links: [], planets: ["Faraway", "Moon"] },
	},
	planetSets: { Earth: ["A"], Nearby: ["B"], Faraway: ["All"], Moon: ["B"] },
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
