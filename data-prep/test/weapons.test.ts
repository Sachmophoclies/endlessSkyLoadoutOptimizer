import { test } from "node:test";
import assert from "node:assert/strict";
import { parseData } from "../src/dataNode.ts";
import { deriveWeapon, loadWeaponNode, newRawWeapon } from "../src/weapons.ts";

function weaponFrom(text: string, others: Record<string, string> = {}) {
	const load = (t: string) => {
		const w = newRawWeapon();
		loadWeaponNode(w, parseData(t)[0]);
		return w;
	};
	const raw = Object.fromEntries(Object.entries(others).map(([k, v]) => [k, load(v)]));
	return deriveWeapon(load(text), name => raw[name]);
}

test("lifetime-1 weapon is instantaneous; per-second uses 60/reload", () => {
	const w = weaponFrom("weapon\n\t\"velocity\" 400\n\t\"lifetime\" 1\n\t\"reload\" 1\n\t\"firing energy\" 1.33\n\t\"shield damage\" 1.7\n\t\"hull damage\" 2.4");
	assert.equal(w.instantaneous, true);
	assert.equal(w.range, 400);
	assert.ok(Math.abs(w.damagePerSecond["shield"] - 102) < 1e-9);
	assert.ok(Math.abs(w.firingPerSecond["energy"] - 79.8) < 1e-9);
});

test("projectile with longer lifetime is not instantaneous", () => {
	const w = weaponFrom("weapon\n\t\"velocity\" 10\n\t\"lifetime\" 60\n\t\"reload\" 15\n\t\"shield damage\" 48\n\tammo \"Javelin\"");
	assert.equal(w.instantaneous, false);
	assert.equal(w.ammo?.outfit, "Javelin");
	assert.equal(w.ammo?.usage, 1);
	assert.equal(w.damagePerSecond["shield"], 192);
});

test("submunitions add damage and lifetime; disabled damage not tested here", () => {
	const w = weaponFrom(
		"weapon\n\t\"lifetime\" 1\n\tsubmunition \"Child\" 3\n\t\"hull damage\" 1",
		{ Child: "weapon\n\t\"lifetime\" 20\n\t\"hull damage\" 10" });
	assert.equal(w.totalLifetime, 21);
	assert.equal(w.instantaneous, false);
	assert.equal(w.damage["hull"], 31);
});

test("exclude submunition damage keeps only own damage", () => {
	const w = weaponFrom(
		"weapon\n\t\"lifetime\" 1\n\tsubmunition \"Child\"\n\t\"exclude submunition damage\"\n\t\"hull damage\" 1",
		{ Child: "weapon\n\t\"hull damage\" 10" });
	assert.equal(w.damage["hull"], 1);
});
