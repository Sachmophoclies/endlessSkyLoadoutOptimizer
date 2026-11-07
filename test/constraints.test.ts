import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONSTRAINTS, loadConstraints } from "../src/core/model.ts";

test("a loadout saved with the old yes/no settings becomes lists", () => {
	const c = loadConstraints({ requireHyperdrive: true, requireJumpDrive: false, requireRamscoop: true, requiredAttributes: ["quantum keystone"], forbidAfterburner: false, plunder: true });
	assert.deepEqual(c.mustContain.map(r => r.name), ["hyperdrive", "ramscoop", "quantum keystone"]);
	assert.deepEqual(c.mustNotContain, []);
	assert.equal(c.plunder, "all");
	assert.ok(!("requireJumpDrive" in c));
});

test("saved lists are kept, and a missing setting falls back to the defaults", () => {
	const c = loadConstraints({ mustContain: [{ kind: "outfit", name: "Hyperdrive", count: 2 }] });
	assert.deepEqual(c.mustContain, [{ kind: "outfit", name: "Hyperdrive", count: 2 }]);
	assert.deepEqual(c.mustNotContain, DEFAULT_CONSTRAINTS.mustNotContain);
});
