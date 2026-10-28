import { test } from "node:test";
import assert from "node:assert/strict";
import { daysSinceEpoch, depreciate, resaleValue } from "../src/save/depreciation.ts";

test("depreciation curve follows the game's default gamerules", () => {
	assert.equal(depreciate(0), 1);
	assert.equal(depreciate(7), 1); // grace period
	assert.equal(depreciate(1007), 0.25); // max age + grace: the floor
	assert.ok(depreciate(100) > depreciate(500));
});

test("copies are sold newest first and unrecorded copies are worth the floor", () => {
	const today = 5000;
	// 1 copy bought today, 2 bought long ago.
	const record: Array<[number, number]> = [[today, 1], [today - 2000, 2]];
	assert.equal(resaleValue(record, 1000, 1, today), 1000);
	assert.equal(resaleValue(record, 1000, 2, today), 1250);
	assert.equal(resaleValue(record, 1000, 4, today), 1000 + 250 * 3); // the 4th has no record
	assert.equal(resaleValue(undefined, 1000, 3, today), 750);
});

test("day numbers match the game's Date class", () => {
	assert.equal(daysSinceEpoch(1, 1, 1) + 1, daysSinceEpoch(2, 1, 1));
	assert.equal(daysSinceEpoch(1, 1, 3052) - daysSinceEpoch(1, 1, 3051), 365);
});
