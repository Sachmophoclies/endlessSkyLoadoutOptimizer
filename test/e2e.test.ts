import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseSave } from "../src/save/parseSave.ts";
import { buildProblem } from "../src/core/problem.ts";
import { DEFAULT_ADVANCED, DEFAULT_CONSTRAINTS, DEFAULT_WEIGHTS, STAT_KEYS } from "../src/core/model.ts";
import { evaluate } from "../src/core/stats.ts";
import { DEFAULT_GA, runGA } from "../src/ga/ga.ts";

// Set ES_SAVE to the path of a real save file to run this test; it is skipped otherwise.
const SAVE = process.env.ES_SAVE ?? "";
const present = SAVE !== "" && existsSync(SAVE) && existsSync("public/data/outfits.json");

test("Hurricane group: baseline is feasible and GA does not regress", { skip: !present }, async () => {
	const save = parseSave(readFileSync(SAVE, "utf8"));
	const outfits = JSON.parse(readFileSync("public/data/outfits.json", "utf8"));
	const group = save.groups.find(g => g.model === "Hurricane")!;
	assert.ok(group.ships.length > 1);
	const built = buildProblem({
		group, save, outfits, sources: new Set(outfits.map((o: any) => o.source)),
		weights: DEFAULT_WEIGHTS, constraints: { ...DEFAULT_CONSTRAINTS, instantaneousOnly: false, noAmmo: false, requireJumpDrive: false, positiveEnergy: false, heatSustainable: false, ownedLimits: true }, adv: DEFAULT_ADVANCED,
	});
	const base = evaluate(built.problem, built.baseline);
	console.log("pool", built.problem.pool.length, "violation", base.violation);
	console.log(STAT_KEYS.map((k, i) => `${k}=${base.stats[i].toFixed(1)}`).join(" "));
	assert.equal(base.violation, 0);

	const t = Date.now();
	const out = await runGA(built.problem, built.baseline, built.ownedPerShip,
		{ ...DEFAULT_GA, population: 150, generations: 30 },
		async gs => gs.map(g => evaluate(built.problem, g)), () => {}, () => false);
	console.log("GA ms", Date.now() - t, "best fitness", out.best.fitness);
	console.log(STAT_KEYS.map((k, i) => `${k}=${out.best.result.stats[i].toFixed(1)}`).join(" "));
	console.log(built.problem.pool.filter((_, i) => out.best.genome[i]).map((p, _i) => p.name).join(", "));
	assert.equal(out.best.result.violation, 0);
});
