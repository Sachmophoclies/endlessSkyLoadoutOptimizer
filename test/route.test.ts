import { test } from "node:test";
import assert from "node:assert/strict";
import { planTrip, makeRouter } from "../src/core/route.ts";
import type { MapData } from "../src/core/stops.ts";

// A--B--C--D on a line, plus E far away (only reachable by jump drive from D).
const sys = (x: number, links: string[] = []) => ({ pos: [x, 0] as [number, number], links, planets: [] });
const map: MapData = {
	systems: { A: sys(0, ["B"]), B: sys(50, ["C"]), C: sys(100, ["D"]), D: sys(150), E: sys(230), F: sys(1000) },
	planetSets: {}, requires: [],
};
const hyper = { useJumpDrive: false, jumpRange: 100 };
const jump = { useJumpDrive: true, jumpRange: 100 };

test("A* finds the fewest jumps", () => {
	assert.deepEqual(makeRouter(map, hyper).path("A", "D"), ["B", "C", "D"]);
	// With a jump drive A can skip straight to C (100 units away).
	assert.deepEqual(makeRouter(map, jump).path("A", "D"), ["C", "D"]);
	assert.deepEqual(makeRouter(map, hyper).path("A", "A"), []);
});

test("systems no hop can reach are reported", () => {
	assert.equal(makeRouter(map, hyper).path("A", "E"), null);
	assert.deepEqual(makeRouter(map, jump).path("D", "E"), ["E"]);
	assert.equal(makeRouter(map, jump).path("A", "F"), null);
});

test("trip visits stops in the order that needs the fewest jumps", () => {
	const trip = planTrip(map, "B", ["D", "A", "C"], hyper);
	assert.deepEqual(trip.legs.map(l => l.to), ["A", "C", "D"]);
	assert.equal(trip.jumps, 1 + 2 + 1);
	assert.deepEqual(trip.unreachable, []);
});

test("a stop at the start costs nothing and unreachable stops are listed", () => {
	const trip = planTrip(map, "A", ["A", "F"], jump);
	assert.deepEqual(trip.legs.map(l => l.to), ["A"]);
	assert.equal(trip.jumps, 0);
	assert.deepEqual(trip.unreachable, ["F"]);
});
