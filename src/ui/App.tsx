import { useEffect, useMemo, useRef, useState } from "react";
import type { OutfitData } from "../../data-prep/src/types.ts";
import {
	type Advanced, type Constraints, DEFAULT_ADVANCED, DEFAULT_CONSTRAINTS, DEFAULT_WEIGHTS,
	STAT_KEYS, STAT_LABELS, type StatKey, type Weights,
} from "../core/model.ts";
import { type Built, buildProblem, unsatisfiable } from "../core/problem.ts";
import { defaultSources, isGameSource, obtainableOutfits, sourceAccess } from "../core/sources.ts";
import { resaleList, shoppingList } from "../core/shopping.ts";
import { DEFAULT_JUMP_RANGE, planTrip } from "../core/route.ts";
import { type MapData, applyEvents, landablePlanets, pathFromVisible, planStops, unshroudedPlanets } from "../core/stops.ts";
import { evaluate } from "../core/stats.ts";
import { DEFAULT_GA, type GAOutcome, type GAParams, type Progress, runSearch } from "../ga/ga.ts";
import { type Limits, computeLimits } from "../ga/limits.ts";
import { createPool } from "../ga/pool.ts";
import { type SaveData, parseSave } from "../save/parseSave.ts";
import { Chart } from "./Chart.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
// marker: where the current loadout sits on this stat, 0 (cheapest valid loadout) to 1 (best this ship can reach); a caret above the track.
function SliderRow(p: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; marker?: number | null; hint?: string }) {
	const set = (v: number): void => p.onChange(Math.min(p.max, Math.max(p.min, Number((Math.round(v / p.step) * p.step).toFixed(4)))));
	return (
		<div className="slider" title={p.hint}>
			<span>{p.label}</span>
			<div className="track">
				<input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={e => set(Number(e.target.value))} />
				{p.marker != null && <span className="caret" style={{ left: `calc(7px + (100% - 14px) * ${p.marker})` }} />}
			</div>
			<button onClick={() => set(p.value - p.step)} disabled={p.value <= p.min} aria-label="Decrease">−</button>
			<input type="number" min={p.min} max={p.max} step={p.step} value={p.value}
				onChange={e => e.target.value !== "" && Number.isFinite(Number(e.target.value)) && set(Number(e.target.value))} />
			<button onClick={() => set(p.value + p.step)} disabled={p.value >= p.max} aria-label="Increase">+</button>
		</div>
	);
}

// Simple mode picks an archetype, intermediate mode sets its four sliders, advanced mode edits every weight directly.
// The modes are mutually exclusive: only the active one feeds the search.
interface Simple { offence: number; defence: number; manoeuvre: number; logistics: number; crew?: number }

const DEFAULT_SIMPLE: Simple = { offence: 70, defence: 60, manoeuvre: 40, logistics: 30 };
const ARCHETYPES = {
	Balanced: DEFAULT_SIMPLE,
	Brawler: { offence: 100, defence: 50, manoeuvre: 30, logistics: 10 },
	Tank: { offence: 50, defence: 100, manoeuvre: 20, logistics: 10 },
	Skirmisher: { offence: 70, defence: 30, manoeuvre: 100, logistics: 20 },
	Explorer: { offence: 30, defence: 40, manoeuvre: 50, logistics: 100 },
	Boarder: { offence: 30, defence: 100, manoeuvre: 30, logistics: 10, crew: 100 },
} satisfies Record<string, Simple>;
type Archetype = keyof typeof ARCHETYPES;
const ZERO: Weights = Object.fromEntries(STAT_KEYS.map(k => [k, 0])) as Weights;

// Bulk Trader, an Advanced-only archetype: cargo first, then one of four ways to spend the rest of the ship.
const BULK_TRADER = {
	"Nimble": { cargo: 70, turning: 40, thrust: 40, maxSpeed: 30, offence: 10, shieldRegen: 10, jumps: 20, fuelCapacity: 10 },
	"Balanced": {
		cargo: 70, offence: 30, shieldRegen: 25, hullRepair: 10, shieldProtection: 10, hullProtection: 10, missileDefence: 20,
		turning: 20, thrust: 20, maxSpeed: 15, jumps: 25, fuelCapacity: 10,
	},
	"Tank": {
		cargo: 70, offence: 20, shieldRegen: 50, hullRepair: 30, shieldProtection: 25, hullProtection: 25, missileDefence: 30,
		jumps: 20, fuelCapacity: 10,
	},
	"Max carry": { cargo: 100, shieldRegen: 5, jumps: 20, fuelCapacity: 20 },
} satisfies Record<string, Partial<Weights>>;

// Boarder, also Advanced-only in this form: spare crew first, then how much of the ship goes to surviving the approach.
const BOARDER = {
	"Defensive": {
		spareCrew: 50, shieldRegen: 40, hullRepair: 25, shieldProtection: 25, hullProtection: 25, missileDefence: 30,
		offence: 15, turning: 10, thrust: 10, jumps: 10, fuelCapacity: 5,
	},
	"Balanced": {
		spareCrew: 70, offence: 30, shieldRegen: 30, hullRepair: 15, shieldProtection: 10, hullProtection: 10, missileDefence: 20,
		turning: 15, thrust: 15, maxSpeed: 10, jumps: 10, fuelCapacity: 5,
	},
	"Max Troops": { spareCrew: 100, shieldRegen: 5, jumps: 10, fuelCapacity: 5 },
} satisfies Record<string, Partial<Weights>>;
const FAMILIES = { "Bulk Trader": BULK_TRADER, "Boarder": BOARDER } as Record<string, Record<string, Partial<Weights>>>;

function expandSimple(s: Simple): Weights {
	return {
		...ZERO,
		offence: s.offence,
		shieldRegen: s.defence * 0.35, shieldProtection: s.defence * 0.1, hullProtection: s.defence * 0.1,
		hullRepair: s.defence * 0.15, missileDefence: s.defence * 0.3,
		turning: s.manoeuvre * 0.4, thrust: s.manoeuvre * 0.35, maxSpeed: s.manoeuvre * 0.25,
		jumps: s.logistics * 0.35, fuelCapacity: s.logistics * 0.25, fuelRegen: s.logistics * 0.25, cargo: s.logistics * 0.15,
		spareCrew: s.crew ?? 0, cost: 10,
	};
}

// The third entry marks a box that is ticked when the setting is off ("Ignore ..." wording).
const CONSTRAINT_LABELS: Array<[keyof Constraints, string, boolean?, string?]> = [
	["instantaneousOnly", "Instantaneous weapons only", false,
		"Instantaneous weapons (beams) hit the moment they fire, so damage stops as soon as your escorts stop shooting. " +
		"Any other weapon leaves projectiles in flight that still land after the trigger is released, and they can destroy an enemy you meant to disable or capture."],
	["noAmmo", "Do not use ammunition", false,
		"Leaves out weapons that spend ammunition, such as missiles and torpedoes. They stop working when the ammo runs out and have to be restocked."],
	["plunder", "Include plunderable outfits", false,
		"Allows outfits that no outfitter sells and that you can only get by plundering enemy ships, such as many Korath and Quarg outfits. " +
		"They are assumed to be available in any number, with no license needed. Off: only outfits you own or can buy count."],
	["positiveEnergy", "Ignore energy when firing", true,
		"Unticked: a loadout is rejected if its generators and batteries cannot power every weapon firing at once (batteries are counted for about 30 seconds). " +
		"Ticked: such loadouts are allowed, but their offence is reduced to what the energy can support."],
	["heatSustainable", "Ignore heat when firing", true,
		"Unticked: a loadout is rejected if firing every weapon would push the ship past 90% of its heat capacity once it settles. " +
		"Ticked: such loadouts are allowed, but their offence is reduced to what the cooling can support."],
	["ownedLimits", "Owned outfits only", false,
		"Uses only the copies you already own, so there is nothing to buy. Off: any outfit sold by the selected sources can be bought in any number."],
	["ignoreLicenses", "Ignore licenses", false,
		"Outfits that need a license you do not hold are normally left out. Ticked: they are allowed anyway."],
	["includeShrouded", "Include shrouded outfitters"],
];
const MUST_CONTAIN: Array<[keyof Constraints, string, string?]> = [
	["requireHyperdrive", "Hyperdrive"],
	["requireJumpDrive", "Jump drive", "Every ship must carry a jump drive, which can also reach systems that are not linked by hyperlane."],
	["requireRamscoop", "Ramscoop"],
];
const ATTRIBUTE_INFO = "Some planets are only reachable if this outfit is equipped. If you do not own this outfit and have not reached a planet that sells it, the option is disabled.";
const MINIMUM_INFO = {
	minFuel: "Rejects loadouts whose fuel capacity is below this.",
	minCargo: "Rejects loadouts whose cargo space is below this.",
	minBunks: "Rejects loadouts with fewer spare bunks than this. Spare bunks are bunks beyond the crew the ship needs, and they hold boarding parties.",
};

const fmt = (v: number): string => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(Math.abs(v) < 10 ? 2 : 1));

export function App() {
	const [outfits, setOutfits] = useState<OutfitData[]>([]);
	const [save, setSave] = useState<SaveData | null>(null);
	const [error, setError] = useState("");
	const [fileName, setFileName] = useState("");
	const [groupId, setGroupId] = useState("");
	const [sources, setSources] = useState<Set<string>>(new Set());
	const [mode, setMode] = useState<"simple" | "intermediate" | "advanced">("simple");
	const [archetype, setArchetype] = useState<Archetype>("Balanced");
	const [family, setFamily] = useState("Bulk Trader"); // which variant row Advanced shows
	const [trader, setTrader] = useState<string | null>(null); // the selected variant; null while that row is closed
	const [simple, setSimple] = useState<Simple>(DEFAULT_SIMPLE);
	const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
	const [constraints, setConstraints] = useState<Constraints>(DEFAULT_CONSTRAINTS);
	const [adv, setAdv] = useState<Advanced>(DEFAULT_ADVANCED);
	const [ga, setGa] = useState<GAParams>(DEFAULT_GA);
	const [workers, setWorkers] = useState(Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 1)));
	const [running, setRunning] = useState(false);
	const [history, setHistory] = useState<Progress[]>([]);
	const [result, setResult] = useState<{ built: Built; outcome: GAOutcome; groupId: string; sources: string[] } | null>(null);
	const [loaded, setLoaded] = useState("");
	const [keepId, setKeepId] = useState("");
	const [convertId, setConvertId] = useState("");
	const [baseMap, setMapData] = useState<MapData | null>(null);
	const [outfitSets, setOutfitSets] = useState<Record<string, string[]> | null>(null);
	const mapData = useMemo(() => (baseMap && save ? applyEvents(baseMap, save.events) : baseMap), [baseMap, save]);
	const stop = useRef(false);
	const [limits, setLimits] = useState<{ key: string; limits: Limits } | null>(null);
	const [limitsBusy, setLimitsBusy] = useState(false);
	useEffect(() => {
		const load = <T,>(file: string, set: (value: T) => void): void => {
			fetch(`${import.meta.env.BASE_URL}data/${file}`)
				.then(r => r.json() as Promise<T>)
				.then(set)
				.catch(e => setError(`Could not load game data: ${e}`));
		};
		load<MapData>("map.json", setMapData);
		load<{ sets: Record<string, string[]> }>("outfitters.json", o => setOutfitSets(o.sets));
	}, []);
	useEffect(() => {
		fetch(`${import.meta.env.BASE_URL}data/outfits.json`)
			.then(r => r.json() as Promise<OutfitData[]>)
			.then(data => {
				setOutfits(data);
				setSources(new Set(data.map(o => o.source).filter(isGameSource)));
			})
			.catch(e => setError(`Could not load game data: ${e}`));
	}, []);

	// Sources the player can actually reach: sold on a visited planet, or already held.
	const access = useMemo(() => (save && mapData && outfitSets ? sourceAccess(save, outfits, mapData.planetSets, outfitSets) : null), [save, outfits, mapData, outfitSets]);
	useEffect(() => {
		if(access)
			setSources(defaultSources(access));
	}, [access]);

	// Landing-permit attributes ("requires: <attribute>" on planets) that at least one installable outfit provides.
	// Mission-only outfits ("installable" -1, e.g. the Radiant Shield Shunt) do not count.
	const providers = (attribute: string): OutfitData[] => outfits.filter(o => (o.attributes[attribute] ?? 0) > 0 && (o.attributes.installable ?? 0) >= 0);
	const accessAttributes = useMemo(
		() => (mapData?.requires ?? []).filter(a => providers(a).length > 0),
		[mapData, outfits]);
	// With a save loaded, an access attribute is only selectable once an outfit providing it is held or sold on a visited planet.
	const reachable = useMemo(() => {
		if(!save || !mapData || !outfitSets)
			return null;
		const have = obtainableOutfits(save, mapData.planetSets, outfitSets);
		return new Set(accessAttributes.filter(a => providers(a).some(o => have.has(o.name))));
	}, [save, mapData, outfitSets, accessAttributes, outfits]);
	// Whatever the save has reached is ticked by default; the rest stay unticked.
	useEffect(() => {
		if(reachable)
			setConstraints(c => ({ ...c, requiredAttributes: [...reachable] }));
	}, [reachable]);

	const group = save?.groups.find(g => g.id === groupId);
	const sourceCounts = useMemo(() => {
		const m = new Map<string, { total: number; licensed: number }>();
		const licensed = new Set(save?.licenses ?? []);
		for(const o of outfits)
		{
			const s = m.get(o.source) ?? { total: 0, licensed: 0 };
			++s.total;
			if(o.licenses.every(l => licensed.has(l)))
				++s.licensed;
			m.set(o.source, s);
		}
		return [...m].filter(([s]) => isGameSource(s)).sort(([a], [b]) => a.localeCompare(b));
	}, [outfits, save]);

	async function onFile(file: File | undefined) {
		if(!file)
			return;
		try {
			const data = parseSave(await file.text());
			if(!data.groups.length)
				throw new Error("No ships found in this file");
			setSave(data);
			setFileName(file.name);
			setGroupId(data.groups[0].id);
			setKeepId("");
			setConvertId("");
			setResult(null);
			setError("");
		} catch(e) {
			setFileName("");
			setError(`Could not read save: ${e instanceof Error ? e.message : e}`);
		}
	}

	// The advanced sliders show where the current loadout stands for the selected group. The limits depend on the pool and
	// non-negotiables, not on the weights, so they are recomputed only when those change.
	const limitsKey = group ? JSON.stringify([group.id, [...sources].sort(), constraints, adv, !!save]) : "";
	useEffect(() => {
		if(mode !== "advanced" || !group || !save || !outfits.length || running || limits?.key === limitsKey)
			return;
		let cancelled = false;
		let pool: ReturnType<typeof createPool> | null = null;
		const timer = setTimeout(async () => {
			const built = buildProblem({ group, save, outfits, sources, weights: DEFAULT_WEIGHTS, constraints, adv });
			if(unsatisfiable(built.problem).length)
				return;
			setLimitsBusy(true);
			pool = createPool(built.problem, workers);
			try {
				const out = await computeLimits(built.problem, built.baseline, built.ownedPerShip, pool.evaluate, () => cancelled, () => {});
				if(out && !cancelled)
					setLimits({ key: limitsKey, limits: out });
			} catch {
				// carets are optional; leave them off if the calculation fails
			} finally {
				pool?.close();
				if(!cancelled)
					setLimitsBusy(false);
			}
		}, 400);
		// Starting a search (or changing anything the limits depend on) ends the calculation at once: the workers are terminated.
		return () => { cancelled = true; clearTimeout(timer); pool?.close(); setLimitsBusy(false); };
	}, [mode, limitsKey, running, outfits.length]); // eslint-disable-line react-hooks/exhaustive-deps

	const caretFor = (k: StatKey): { marker: number | null; hint?: string } => {
		const l = limits?.key === limitsKey ? limits.limits : null;
		const i = STAT_KEYS.indexOf(k);
		if(!l || k === "cost" || !(l.ceiling[i] > l.floor[i]))
			return { marker: null };
		const marker = Math.max(0, Math.min(1, (l.current[i] - l.floor[i]) / (l.ceiling[i] - l.floor[i])));
		return { marker, hint: `Current ${fmt(l.current[i])} (cheapest valid ${fmt(l.floor[i])}, best possible ${fmt(l.ceiling[i])})` };
	};

	async function run() {
		if(!group || !save)
			return;
		stop.current = false;
		setRunning(true);
		setHistory([]);
		setResult(null);
		setLoaded("");
		const activeWeights = mode === "advanced" ? weights : expandSimple(mode === "simple" ? ARCHETYPES[archetype] : simple);
		const activeAdv = mode === "advanced" ? adv : DEFAULT_ADVANCED;
		const built = buildProblem({ group, save, outfits, sources, weights: activeWeights, constraints, adv: activeAdv });
		const blocked = unsatisfiable(built.problem);
		if(blocked.length)
		{
			setError(`No loadout can satisfy these non-negotiables. ${blocked.join(". ")}. Untick them or pick another group.`);
			setRunning(false);
			return;
		}
		setError("");
		const pool = createPool(built.problem, workers);
		const log: Progress[] = [];
		let last = 0;
		try {
			const outcome = await runSearch(built.problem, built.baseline, built.ownedPerShip, ga, pool.evaluate,
				p => {
					log.push(p);
					if(performance.now() - last > 100)
					{
						last = performance.now();
						setHistory([...log]);
					}
				}, () => stop.current);
			setHistory([...log]);
			setResult({ built, outcome, groupId: group.id, sources: [...sources] });
		} catch(e) {
			setError(`Search failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			pool.close();
			setRunning(false);
		}
	}

	// A saved loadout is the outfit counts plus the settings it was found with, so it can be rebuilt and compared again.
	function saveLoadout() {
		if(!result || !group)
			return;
		const { problem } = result.built;
		const outfitCounts: Record<string, number> = {};
		problem.pool.forEach((p, i) => {
			if(result.outcome.best.genome[i] > 0)
				outfitCounts[p.name] = result.outcome.best.genome[i];
		});
		const file: SavedLoadout = {
			format: "endless-sky-loadout", version: 1, savedAt: new Date().toISOString(), groupId: result.groupId, model: group.model,
			outfits: outfitCounts, weights: problem.weights, constraints: problem.constraints, adv: problem.adv, sources: result.sources,
		};
		const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: "application/json" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = `loadout-${group.model.replace(/[^\w-]+/g, "_")}.json`;
		link.click();
		URL.revokeObjectURL(url);
	}

	async function loadLoadout(file: File | undefined) {
		if(!file)
			return;
		try {
			if(!save)
				throw new Error("load a save file first");
			const saved = JSON.parse(await file.text()) as SavedLoadout;
			if(saved.format !== "endless-sky-loadout" || !saved.outfits)
				throw new Error("not a saved loadout");
			const target = save.groups.find(g => g.id === saved.groupId);
			if(!target)
				throw new Error(`this save has no ${saved.model} group with that loadout`);
			const built = buildProblem({
				group: target, save, outfits, sources: new Set(saved.sources),
				weights: { ...DEFAULT_WEIGHTS, ...saved.weights }, constraints: { ...DEFAULT_CONSTRAINTS, ...saved.constraints },
				adv: { ...DEFAULT_ADVANCED, ...saved.adv },
			});
			const genome = new Int16Array(built.problem.pool.length);
			let missing = 0;
			for(const [name, count] of Object.entries(saved.outfits))
			{
				const i = built.problem.pool.findIndex(p => p.name === name);
				if(i < 0)
					missing += count;
				else
					genome[i] = count;
			}
			const best = { genome, result: evaluate(built.problem, genome), fitness: 0 };
			setGroupId(target.id);
			setHistory([]);
			setResult({ built, outcome: { best, top: [best], generations: 0 }, groupId: target.id, sources: saved.sources });
			setLoaded(`Loaded ${saved.model} loadout${saved.savedAt ? ` saved ${new Date(saved.savedAt).toLocaleString()}` : ""}${missing ? ` (${missing} outfits unavailable)` : ""}`);
			setError("");
		} catch(e) {
			setError(`Could not load loadout: ${e instanceof Error ? e.message : e}`);
		}
	}

	// Shows what turning one group into another group's loadout takes, using the same result view as a search.
	function consolidate() {
		const keep = save?.groups.find(g => g.id === keepId), target = save?.groups.find(g => g.id === convertId);
		if(!save || !keep || !target)
			return;
		const allSources = outfits.map(o => o.source).filter(isGameSource);
		const built = buildProblem({
			group: target, save, outfits, sources: new Set(allSources),
			weights: mode === "advanced" ? weights : expandSimple(mode === "simple" ? ARCHETYPES[archetype] : simple),
			constraints: { ...DEFAULT_CONSTRAINTS, instantaneousOnly: false, noAmmo: false, ignoreLicenses: true, plunder: true, ownedLimits: false },
			adv: mode === "advanced" ? adv : DEFAULT_ADVANCED,
		});
		built.problem.constraints = constraints;
		const genome = new Int16Array(built.problem.pool.length);
		let missing = 0;
		for(const [name, count] of Object.entries(keep.outfits))
		{
			const i = built.problem.pool.findIndex(p => p.name === name);
			if(i < 0)
				missing += count;
			else
				genome[i] = count;
		}
		const best = { genome, result: evaluate(built.problem, genome), fitness: 0 };
		setGroupId(target.id);
		setHistory([]);
		setResult({ built, outcome: { best, top: [best], generations: 0 }, groupId: target.id, sources: allSources });
		setLoaded(`Converting ${target.model} ×${target.ships.length} to the ${keep.model} ×${keep.ships.length} loadout${missing ? ` (${missing} outfits unavailable)` : ""}`);
		setError("");
	}

	const setWeight = (k: StatKey, v: number) => setWeights(w => ({ ...w, [k]: v }));
	const last = history[history.length - 1];

	return (
		<div className="app">
			<div className="col">
				<div className="card">
					<h1>Endless Sky loadout optimizer</h1>
					<div className="muted">Everything runs in your browser; the save never leaves your machine.</div>
					<p className="row">
						<span className="filepick">
							<span className="filepick-face">Choose save file…</span>
							<input type="file" aria-label="Choose save file" accept=".txt,text/plain" onChange={e => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
						</span>
						{fileName ? <span className="up">✓ File parsed <span className="muted">({fileName})</span></span> : <span className="muted">No save loaded</span>}
					</p>
					<div className="muted">{outfits.length ? `Game data loaded (${outfits.length} outfits).` : "Loading game data…"}</div>
					{save && <div className="muted">{save.pilot || "Pilot"}: {save.ships.length} ships in {save.groups.length} groups, {save.licenses.length} licenses</div>}
					{error && <div className="error">{error}</div>}
				</div>

				{save && <div className="card">
					<h2>Ship group</h2>
					<div className="list">
						{save.groups.map(g => (
							<label key={g.id}>
								<input type="radio" name="group" checked={g.id === groupId} onChange={() => setGroupId(g.id)} />
								<span>{g.model} ×{g.ships.length} <span className="muted">({g.ships[0].name}{g.ships.length > 1 ? ", …" : ""}; {Object.values(g.outfits).reduce((a, b) => a + b, 0)} outfits)</span></span>
							</label>
						))}
					</div>
				</div>}

				{save && save.groups.some(g => save.groups.some(o => o !== g && o.model === g.model)) && <div className="card">
					<h2>Consolidate</h2>
					<div className="row" style={{ flexWrap: "wrap" }}>
						<label>Keep
							<select value={keepId} onChange={e => { setKeepId(e.target.value); setConvertId(""); }}>
								<option value="" />
								{save.groups.filter(g => save.groups.some(o => o !== g && o.model === g.model)).map(g => <option key={g.id} value={g.id}>{g.model} ×{g.ships.length}</option>)}
							</select>
						</label>
						<label>Convert
							<select value={convertId} onChange={e => setConvertId(e.target.value)} disabled={!keepId}>
								<option value="" />
								{save.groups.filter(g => g.id !== keepId && g.model === save.groups.find(k => k.id === keepId)?.model).map(g => <option key={g.id} value={g.id}>{g.model} ×{g.ships.length}</option>)}
							</select>
						</label>
						<button disabled={!keepId || !convertId || running || !outfits.length} onClick={consolidate}>Show changes</button>
					</div>
				</div>}

				<Fold title="Outfit sources">
					<div className="row"><button onClick={() => setSources(new Set(outfits.map(o => o.source).filter(isGameSource)))}>All</button><button onClick={() => setSources(new Set())}>None</button>{access && <button onClick={() => setSources(defaultSources(access))}>Reachable</button>}</div>
					<div className="list">
						{sourceCounts.map(([name, c]) => (
							<label key={name}>
								<input type="checkbox" checked={sources.has(name)} onChange={e => setSources(s => {
									const next = new Set(s);
									e.target.checked ? next.add(name) : next.delete(name);
									return next;
								})} />
								<span>{name} <span className="muted">{save ? `${c.licensed}/${c.total} licensed` : c.total}</span></span>
							</label>
						))}
					</div>
				</Fold>

				<Fold title="Non-negotiables">
					<div className="list" style={{ maxHeight: "none", overflow: "visible" }}>
						{CONSTRAINT_LABELS.map(([key, label, inverted, info]) => (
							<label key={key}>
								<input type="checkbox" checked={(constraints[key] as boolean) !== !!inverted} onChange={e => setConstraints(c => ({ ...c, [key]: e.target.checked !== !!inverted }))} />
								<span>{label}</span>
								{info && <Info text={info} />}
							</label>
						))}
						<div className="muted">Must contain:</div>
						{MUST_CONTAIN.map(([key, label, info]) => (
							<label key={key}>
								<input type="checkbox" checked={constraints[key] as boolean} onChange={e => setConstraints(c => ({ ...c, [key]: e.target.checked }))} />
								<span>{label}</span>
								{info && <Info text={info} />}
							</label>
						))}
						{accessAttributes.map(attribute => (
							<label key={attribute} className={reachable && !reachable.has(attribute) ? "disabled" : undefined}
								title={reachable && !reachable.has(attribute) ? "Not reached yet" : undefined}>
								<input type="checkbox" disabled={!!reachable && !reachable.has(attribute)} checked={constraints.requiredAttributes.includes(attribute)}
									onChange={e => setConstraints(c => ({
										...c,
										requiredAttributes: e.target.checked ? [...c.requiredAttributes, attribute] : c.requiredAttributes.filter(a => a !== attribute),
									}))} />
								<span>{attribute.charAt(0).toUpperCase() + attribute.slice(1)}</span>
								<Info text={ATTRIBUTE_INFO} />
							</label>
						))}
						<details>
							<summary>Advanced</summary>
							{(["minFuel", "minCargo", "minBunks"] as const).map(key => (
								<label key={key}>
									<span>{{ minFuel: "Min fuel capacity", minCargo: "Min cargo space", minBunks: "Min spare crew" }[key]}</span>
									<input type="number" min={0} value={constraints[key]} onChange={e => setConstraints(c => ({ ...c, [key]: Number(e.target.value) }))} />
									<Info text={MINIMUM_INFO[key]} />
								</label>
							))}
						</details>
					</div>
				</Fold>
			</div>

			<div className="col">
				<div className="card">
					<h2>Weights{limitsBusy && mode === "advanced" && <span className="busy" role="status"><span className="spinner" />Rating current loadout…</span>}</h2>
					<div className="tabs">
						<button aria-pressed={mode === "simple"} onClick={() => setMode("simple")}>Simple</button>
						<button aria-pressed={mode === "intermediate"} onClick={() => setMode("intermediate")}>Intermediate</button>
						<button aria-pressed={mode === "advanced"} onClick={() => setMode("advanced")}>Advanced</button>
					</div>
					{mode === "simple" ? (Object.keys(ARCHETYPES) as Archetype[]).map(name => (
						<label key={name}>
							<input type="radio" name="archetype" checked={archetype === name} onChange={() => setArchetype(name)} />
							<span>{name}</span>
						</label>
					)) : mode === "intermediate" ? <>
						<div className="sliders">{([["offence", "Offence"], ["defence", "Defence (regen, protection, anti-missile)"], ["manoeuvre", "Maneuverability (turning, thrust, speed)"], ["logistics", "Logistics (fuel capacity, fuel regen, jumps, cargo)"]] as const).map(([k, label]) => (
							<SliderRow key={k} label={label} min={0} max={100} step={1} value={simple[k]} onChange={v => setSimple(s => ({ ...s, [k]: v }))} />
						))}</div>
					</> : <>
					<div className="tabs">
						{(Object.keys(ARCHETYPES) as Archetype[]).filter(name => !(name in FAMILIES)).map(name => (
							<button key={name} onClick={() => { setTrader(null); setWeights(expandSimple(ARCHETYPES[name])); }}>{name}</button>
						))}
						{["Boarder", "Bulk Trader"].map(name => (
							<button key={name} aria-pressed={trader !== null && family === name}
								onClick={() => { setFamily(name); setTrader("Balanced"); setWeights({ ...ZERO, cost: 10, ...FAMILIES[name].Balanced }); }}>{name}</button>
						))}
						<button onClick={() => { setTrader(null); setWeights(Object.fromEntries(STAT_KEYS.map(k => [k, Math.round((caretFor(k).marker ?? 0) * 100)])) as Weights); }}>Reset</button>
					</div>
					<div className={`slide${trader ? " open" : ""}`}>
						<div className="tabs">
							{Object.keys(FAMILIES[family]).map(name => (
								<button key={name} aria-pressed={trader === name} tabIndex={trader ? 0 : -1}
									onClick={() => { setTrader(name); setWeights({ ...ZERO, cost: 10, ...FAMILIES[family][name] }); }}>{name}</button>
							))}
						</div>
					</div>
					<div className="sliders">
						{STAT_KEYS.map(k => (
							<SliderRow key={k} label={STAT_LABELS[k] + (k === "cost" ? " (penalty)" : "")} min={0} max={100} step={1}
								value={weights[k]} onChange={v => setWeight(k, v)} {...caretFor(k)} />
						))}
					</div>
					<details className="fold" style={{ paddingTop: 12 }}>
						<summary><h2>Status damage and model options</h2></summary>
						<div className="muted">Status damage weights, applied to each channel's per-second value (game value x100) inside offence.</div>
						<div className="sliders">
							{(["ion", "disruption", "slowing", "scrambling"] as const).map(k => (
								<SliderRow key={k} label={`${k} damage`} min={0} max={5} step={0.1} value={adv[k]} onChange={v => setAdv(x => ({ ...x, [k]: v }))} />
							))}
							<SliderRow label="Movement duty (energy/heat budget)" min={0} max={1} step={0.05} value={adv.moveDuty} onChange={v => setAdv(x => ({ ...x, moveDuty: v }))} />
							<SliderRow label="Ammo must last (s)" min={5} max={300} step={5} value={adv.ammoHorizon} onChange={v => setAdv(x => ({ ...x, ammoHorizon: v }))} />
							<SliderRow label="Battery covers deficit (s)" min={5} max={120} step={5} value={adv.batteryHorizon} onChange={v => setAdv(x => ({ ...x, batteryHorizon: v }))} />
						</div>
					</details>
					</>}
				</div>

				<div className="card">
					<div className="row">
						<button className="primary" disabled={!group || running || !outfits.length} onClick={run}>{running ? "Running…" : "Find best loadout"}</button>
						<button disabled={!running} onClick={() => { stop.current = true; }}>Stop</button>
						{last && <span className="muted">gen {last.gen}/{ga.generations} · best {last.best.toFixed(3)} · feasible {(last.feasibleShare * 100).toFixed(0)}%</span>}
						<div className="row icons">
							<button title="Save loadout" aria-label="Save loadout" disabled={!result || running || result.groupId !== groupId} onClick={saveLoadout}>💾</button>
							<span className="filepick">
								<span className="filepick-face" title="Load loadout">📂</span>
								<input type="file" aria-label="Load loadout" accept=".json,application/json" disabled={running || !save || !outfits.length} onChange={e => { void loadLoadout(e.target.files?.[0]); e.target.value = ""; }} />
							</span>
						</div>
					</div>
					<details className="run-settings">
						<summary>Search settings</summary>
						<div className="row" style={{ flexWrap: "wrap" }}>
							{([["population", "Population"], ["generations", "Generations"], ["stagnation", "Stop after idle"], ["runs", "Runs"]] as const).map(([k, label]) => (
								<label key={k}>{label}<input type="number" min={1} value={ga[k]} onChange={e => setGa(p => ({ ...p, [k]: Number(e.target.value) }))} /></label>
							))}
							<label>Workers<input type="number" min={0} max={32} value={workers} onChange={e => setWorkers(Number(e.target.value))} /></label>
						</div>
					</details>
					{loaded ? <div className="up">✓ {loaded}</div> : <>
					<Chart history={history} />
					<ProgressBar max={ga.generations} value={last ? last.gen : 0} done={!running && !!last} />
					<div className="legend">
							<span style={{ color: "var(--c-best)" }}>■ best{last ? ` ${last.best.toFixed(3)}` : ""}</span>
							<span style={{ color: "var(--c-mean)" }}>■ mean{last ? ` ${last.mean.toFixed(3)}` : ""}</span>
							<span style={{ color: "var(--c-div)" }}>■ diversity{last ? ` ${last.diversity.toFixed(2)}` : ""}</span>
							<span>(each line has its own scale)</span>
						</div>
					</>}
				</div>

				{result && save && group && result.groupId === group.id && <Results result={result} save={save} group={group} outfits={outfits} map={mapData} outfitSets={outfitSets} />}
			</div>
		</div>
	);
}

interface SavedLoadout {
	format: "endless-sky-loadout";
	version: number;
	savedAt: string;
	groupId: string;
	model: string;
	outfits: Record<string, number>;
	weights: Weights;
	constraints: Constraints;
	adv: Advanced;
	sources: string[];
}

function Results({ result, save, group, outfits, map, outfitSets }: {
	result: { built: Built; outcome: GAOutcome };
	save: SaveData;
	group: NonNullable<SaveData["groups"][number]>;
	outfits: OutfitData[];
	map: MapData | null;
	outfitSets: Record<string, string[]> | null;
}) {
	const { built, outcome } = result;
	const problem = built.problem;
	const pick = outcome.best;
	const base = useMemo(() => evaluate(problem, built.baseline), [built]);
	const buyable = useMemo(() => new Set(outfits.filter(o => o.sold).map(o => o.name)), [outfits]);
	const lines = useMemo(() => shoppingList(problem, pick.genome, group, save, buyable), [pick]);
	const trip = useMemo(() => {
		if(!map || !outfitSets)
			return null;
		const buy = lines.filter(l => l.toBuy > 0).map(l => ({ name: l.name, count: l.toBuy, cost: l.buyCost }));
		return buy.length ? planStops(buy, map, outfitSets, (visited => problem.constraints.includeShrouded ? visited : unshroudedPlanets(visited, map))(landablePlanets(save.visitedPlanets, map, save.reputation))) : null;
	}, [lines, map, outfitSets, save]);
	// Route from where the pilot is now. A jump drive in the new loadout also allows hops to unlinked systems in range.
	const route = useMemo(() => {
		if(!map || !trip || !save.system)
			return null;
		const installed = problem.pool.filter((p, i) => pick.genome[i] > 0);
		const useJumpDrive = installed.some(p => (p.attrs["jump drive"] ?? 0) > 0);
		const jumpRange = Math.max(DEFAULT_JUMP_RANGE, ...installed.map(p => p.attrs["jump range"] ?? 0));
		return planTrip(map, save.system, trip.stops.map(s => s.system), { useJumpDrive, jumpRange });
	}, [map, trip, save, problem, pick]);
	// Stops in shrouded systems, with the shortest hyperlane chain from a system the map shows.
	const shroudedPaths = useMemo(() => {
		const out = new Map<string, string[] | null>();
		for(const stop of trip?.stops ?? [])
			if(map?.systems[stop.system]?.shrouded)
				out.set(stop.system, pathFromVisible(map, stop.system, save.visitedSystems));
		return out;
	}, [trip, map, save]);
	// "Where to buy" follows the shopping-trip order; stops the route can't reach keep their nearest-Sol order at the end.
	const orderedStops = useMemo(() => {
		if(!trip)
			return [];
		const rank = (system: string): number => {
			const i = route?.legs.findIndex(l => l.to === system) ?? -1;
			return i < 0 ? Infinity : i;
		};
		return [...trip.stops].sort((a, b) => rank(a.system) - rank(b.system));
	}, [trip, route]);
	const diff = problem.pool.map((p, i) => ({ name: p.name, from: built.baseline[i], to: pick.genome[i] })).filter(d => d.from !== d.to)
		.sort((a, b) => Number(a.to > a.from) - Number(b.to > b.from) || a.name.localeCompare(b.name));
	const resale = useMemo(() => resaleList(problem, pick.genome, group, save), [pick]);
	const totalBuy = lines.reduce((s, l) => s + l.buyCost, 0);
	const totalResale = resale.reduce((s, l) => s + l.value, 0);
	const net = totalBuy - totalResale;

	return (
		<>
			<div className="card">
				<h2>Best vs current</h2>
				<table>
					<thead><tr><th>Stat</th><th className="num">Current</th><th className="num">New</th><th className="num">Change</th></tr></thead>
					<tbody>
						{STAT_KEYS.map((k, i) => {
							if(k === "cost")
								return null;
							const a = base.stats[i], b = pick.result.stats[i];
							const better = b > a;
							const pct = a ? ((b - a) / Math.abs(a)) * 100 : b ? 100 : 0;
							return <tr key={k}><td>{STAT_LABELS[k]}</td><td className="num">{fmt(a)}</td><td className="num">{fmt(b)}</td>
								<td className={`num ${Math.abs(pct) < 0.05 ? "" : better ? "up" : "down"}`}>{Math.abs(pct) < 0.05 ? "–" : `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`}</td></tr>;
						})}
					</tbody>
				</table>
			</div>
			<Fold title="Outfit changes (per ship)">
				<table>
					<thead><tr><th>Outfit</th><th className="num">Current</th><th className="num">New</th></tr></thead>
					<tbody>{diff.map(d => <tr key={d.name}><td>{d.name}</td><td className="num down">{d.from || "–"}</td><td className="num up">{d.to || "–"}</td></tr>)}</tbody>
				</table>
				{!diff.length && <div className="muted">Same as the current loadout.</div>}
			</Fold>
			<Fold title={`Shopping list (whole group ×${group.ships.length})`} summary={totalBuy > 0 || totalResale > 0 ? `${net < 0 ? "+" : ""}${Math.abs(net).toLocaleString()} credits net` : "nothing to buy"}>
				<table>
					<thead><tr><th>Outfit</th><th className="num">Need</th><th>From</th></tr></thead>
					<tbody>{lines.map(l => (
						<tr key={l.name}><td>{l.name}</td><td className="num">{l.total}</td>
							<td>
								{l.fromStorage.map(s => `${s.count} from ${s.planet} storage`).join(", ")}
								{l.fromCargo ? ` ${l.fromCargo} from cargo` : ""}
								{l.toBuy ? ` buy ${l.toBuy} (${l.buyCost.toLocaleString()} cr)` : ""}
								{l.plunderShort ? <span className="down"> short by {l.plunderShort} (plunder-only)</span> : ""}
							</td></tr>
					))}</tbody>
				</table>
				{!lines.length && <div className="muted">Nothing new is needed.</div>}
				{resale.length > 0 && <>
					<h3>Sell the outfits you remove</h3>
					<table>
						<thead><tr><th>Outfit</th><th className="num">Count</th><th className="num">Resale</th></tr></thead>
						<tbody>{resale.map(r => <tr key={r.name}><td>{r.name}</td><td className="num">{r.count}</td><td className="num">{r.value.toLocaleString()} cr</td></tr>)}</tbody>
					</table>
				</>}
				{(totalBuy > 0 || totalResale > 0) && <p>
					Purchase {totalBuy.toLocaleString()} cr − resale {totalResale.toLocaleString()} cr = <strong>{net.toLocaleString()} credits net</strong>
				</p>}
			</Fold>
			{trip && <div className="card">
				<h2>Where to buy</h2>
				<div className="muted">Fewest stops using planets you have visited, in shopping-trip order.</div>
				{orderedStops.flatMap(stop => stop.planets.map(p => (
					<div key={`${stop.system}/${p.planet}`}>
						<h3>{stop.system} - {p.planet} <CopyButton text={stop.system} /></h3>
						{shroudedPaths.has(stop.system) && <div className="muted">Shrouded{shroudedPaths.get(stop.system) ? `: ${shroudedPaths.get(stop.system)!.join(" > ")}` : ""}</div>}
						<table>
							<tbody>{p.items.map(i => <tr key={i.name}><td>{i.name}</td><td className="num">{i.count}</td><td className="num">{i.cost.toLocaleString()} cr</td></tr>)}</tbody>
						</table>
					</div>
				)))}
				{trip.unplaced.length > 0 && <div>
					<h3>Not sold on a planet you have visited</h3>
					<table><tbody>{trip.unplaced.map(i => <tr key={i.name}><td>{i.name}</td><td className="num">{i.count}</td></tr>)}</tbody></table>
				</div>}
			</div>}
		</>
	);
}

// A card whose body is collapsed by default; the caret sits at the right of the title.
function Fold({ title, summary, children }: { title: string; summary?: string; children: React.ReactNode }) {
	return (
		<details className="card fold">
			<summary><h2>{title}</h2>{summary && <span className="fold-summary">{summary}</span>}</summary>
			{children}
		</details>
	);
}

// An "i" icon whose popover shows on hover or keyboard focus. Clicking it must not toggle the checkbox it sits in.
function Info({ text }: { text: string }) {
	return (
		<span className="info" tabIndex={0} aria-label={text} onClick={e => e.preventDefault()}>
			ⓘ<span className="pop" role="tooltip">{text}</span>
		</span>
	);
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button className="copy" type="button" title={`Copy "${text}"`} onClick={() => {
			void navigator.clipboard?.writeText(text).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			});
		}}>{copied ? "Copied ✓" : "Copy"}</button>
	);
}
