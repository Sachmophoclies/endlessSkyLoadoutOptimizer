import { test } from "node:test";
import assert from "node:assert/strict";
import { usefulCopies } from "../src/core/dominance.ts";
import type { OutfitData } from "../data-prep/src/types.ts";

const outfit = (name: string, cost: number, mass: number, attributes: Record<string, number>, licenses: string[] = []): OutfitData =>
	({ name, category: "Systems", series: "", cost, mass, attributes, licenses, source: "human", slot: null, weapon: null, sold: true, plunderable: false });

const bunk = outfit("Bunk Room", 40000, 5, { "bunks": 4, "outfit space": -20 });
const small = outfit("Small Bunk Room", 20000, 3, { "bunks": 2, "outfit space": -12 });

test("two small bunk rooms are never needed, one can fill leftover space", () => {
	assert.equal(usefulCopies(small, [bunk, small]), 1);
	assert.equal(usefulCopies(bunk, [bunk, small]), null);
});

test("an outfit with a different license is not a replacement", () => {
	assert.equal(usefulCopies(small, [outfit("Licensed Bunk Room", 40000, 5, { "bunks": 4, "outfit space": -20 }, ["Pilot"])]), null);
});

test("an outfit with no visible gain is not judged", () => {
	const brig = outfit("Brig", 40000, 3, { "outfit space": -3 });
	assert.equal(usefulCopies(brig, [outfit("Nothing", 0, 0, {})]), null);
});
