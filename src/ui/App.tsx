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
import { type MapData, planStops } from "../core/stops.ts";
import { evaluate } from "../core/stats.ts";
import { DEFAULT_GA, type GAOutcome, type GAParams, type Progress, runGA } from "../ga/ga.ts";
import { createPool } from "../ga/pool.ts";
import { type SaveData, parseSave } from "../save/parseSave.ts";
import { Chart } from "./Chart.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
// Simple mode: three sliders that expand into the full weight vector. Advanced mode edits every weight directly.
// The two modes are mutually exclusive: only the active one feeds the search.
interface Simple { offence: number; defence: number; manoeuvre: number; logistics: number }

const DEFAULT_SIMPLE: Simple = { offence: 70, defence: 60, manoeuvre: 40, logistics: 30 };
const ZERO: Weights = Object.fromEntries(STAT_KEYS.map(k => [k, 0])) as Weights;

function expandSimple(s: Simple): Weights {
	return {
		...ZERO,
		offence: s.offence,
		shieldHp: s.defence * 0.35, hullHp: s.defence * 0.35, shieldRegen: s.defence * 0.1,
		hullRepair: s.defence * 0.05, missileDefence: s.defence * 0.15,
		turning: s.manoeuvre * 0.4, thrust: s.manoeuvre * 0.35, maxSpeed: s.manoeuvre * 0.25,
		jumps: s.logistics * 0.35, fuelCapacity: s.logistics * 0.25, fuelRegen: s.logistics * 0.25, cargo: s.logistics * 0.15,
		cost: 10,
	};
}

const CONSTRAINT_LABELS: Array<[keyof Constraints, string]> = [
	["instantaneousOnly", "Instantaneous weapons only"],
	["noAmmo", "No ammo weapons"],
	["requireHyperdrive", "Must have hyperdrive"],
	["requireJumpDrive", "Must have jump drive"],
	["positiveEnergy", "Positive energy balance (firing everything)"],
	["heatSustainable", "Heat sustainable (firing everything)"],
	["ownedLimits", "Owned-count limits (use only what I own)"],
	["ignoreLicenses", "Ignore licenses"],
	["canStrip", "Can strip outfits from other ships"],
];

const fmt = (v: number): string => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(Math.abs(v) < 10 ? 2 : 1));

export function App() {
	const [outfits, setOutfits] = useState<OutfitData[]>([]);
	const [save, setSave] = useState<SaveData | null>(null);
	const [error, setError] = useState("");
	const [fileName, setFileName] = useState("");
	const [groupId, setGroupId] = useState("");
	const [sources, setSources] = useState<Set<string>>(new Set());
	const [mode, setMode] = useState<"simple" | "advanced">("simple");
	const [simple, setSimple] = useState<Simple>(DEFAULT_SIMPLE);
	const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
	const [constraints, setConstraints] = useState<Constraints>(DEFAULT_CONSTRAINTS);
	const [adv, setAdv] = useState<Advanced>(DEFAULT_ADVANCED);
	const [ga, setGa] = useState<GAParams>(DEFAULT_GA);
	const [workers, setWorkers] = useState(Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 1)));
	const [running, setRunning] = useState(false);
	const [history, setHistory] = useState<Progress[]>([]);
	const [result, setResult] = useState<{ built: Built; outcome: GAOutcome; groupId: string } | null>(null);
	const [mapData, setMapData] = useState<MapData | null>(null);
	const [outfitSets, setOutfitSets] = useState<Record<string, string[]> | null>(null);
	const [planetSources, setPlanetSources] = useState<Record<string, string[]> | null>(null);
	const stop = useRef(false);
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
		fetch(`${import.meta.env.BASE_URL}data/planets.json`)
			.then(r => r.json() as Promise<Record<string, string[]>>)
			.then(setPlanetSources)
			.catch(e => setError(`Could not load game data: ${e}`));
		fetch(`${import.meta.env.BASE_URL}data/outfits.json`)
			.then(r => r.json() as Promise<OutfitData[]>)
			.then(data => {
				setOutfits(data);
				setSources(new Set(data.map(o => o.source).filter(isGameSource)));
			})
			.catch(e => setError(`Could not load game data: ${e}`));
	}, []);

	// Sources the player can actually reach: sold on a visited planet, or already held.
	const access = useMemo(() => (save && planetSources ? sourceAccess(save, outfits, planetSources) : null), [save, outfits, planetSources]);
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
	useEffect(() => {
		if(reachable)
			setConstraints(c => c.requiredAttributes.every(a => reachable.has(a)) ? c : { ...c, requiredAttributes: c.requiredAttributes.filter(a => reachable.has(a)) });
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
			setResult(null);
			setError("");
		} catch(e) {
			setFileName("");
			setError(`Could not read save: ${e instanceof Error ? e.message : e}`);
		}
	}

	async function run() {
		if(!group || !save)
			return;
		stop.current = false;
		setRunning(true);
		setHistory([]);
		setResult(null);
		const activeWeights = mode === "simple" ? expandSimple(simple) : weights;
		const activeAdv = mode === "simple" ? DEFAULT_ADVANCED : adv;
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
			const outcome = await runGA(built.problem, built.baseline, built.ownedPerShip, ga, pool.evaluate,
				p => {
					log.push(p);
					if(performance.now() - last > 100)
					{
						last = performance.now();
						setHistory([...log]);
					}
				}, () => stop.current);
			setHistory([...log]);
			setResult({ built, outcome, groupId: group.id });
		} catch(e) {
			setError(`Search failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			pool.close();
			setRunning(false);
		}
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

				<div className="card">
					<h2>Outfit sources</h2>
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
				</div>

				<div className="card">
					<h2>Non-negotiables</h2>
					<div className="list" style={{ maxHeight: "none" }}>
						{CONSTRAINT_LABELS.map(([key, label]) => (
							<label key={key}>
								<input type="checkbox" checked={constraints[key] as boolean} onChange={e => setConstraints(c => ({ ...c, [key]: e.target.checked }))} />
								<span>{label}</span>
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
								<span>Must have {attribute}</span>
							</label>
						))}
						{(["minFuel", "minCargo", "minBunks", "minTurnPercent", "budget"] as const).map(key => (
							<label key={key}>
								<span>{{ minFuel: "Min fuel capacity", minCargo: "Min cargo space", minBunks: "Min spare crew", minTurnPercent: "Min turning (% of current)", budget: "Credit budget (0 = no limit)" }[key]}</span>
								<input type="number" min={0} value={constraints[key]} onChange={e => setConstraints(c => ({ ...c, [key]: Number(e.target.value) }))} />
							</label>
						))}
					</div>
				</div>
			</div>

			<div className="col">
				<div className="card">
					<h2>Weights</h2>
					<div className="tabs">
						<button aria-pressed={mode === "simple"} onClick={() => setMode("simple")}>Simple</button>
						<button aria-pressed={mode === "advanced"} onClick={() => setMode("advanced")}>Advanced</button>
					</div>
					<div className="muted">Only the selected mode is used by the search.</div>
					{mode === "simple" ? <>
						{([["offence", "Offence"], ["defence", "Defence (shields, hull, regen, anti-missile)"], ["manoeuvre", "Maneuverability (turning, thrust, speed)"], ["logistics", "Logistics (fuel capacity, fuel regen, jumps, cargo)"]] as const).map(([k, label]) => (
							<div className="slider" key={k}>
								<span>{label}</span>
								<input type="range" min={0} max={100} value={simple[k]} onChange={e => setSimple(s => ({ ...s, [k]: Number(e.target.value) }))} />
								<span className="muted">{simple[k]}</span>
							</div>
						))}
					</> : <>
					<div className="tabs">
						<button onClick={() => setWeights(DEFAULT_WEIGHTS)}>Reset</button>
					</div>
					{STAT_KEYS.map(k => (
						<div className="slider" key={k}>
							<span>{STAT_LABELS[k]}{k === "cost" ? " (penalty)" : ""}</span>
							<input type="range" min={0} max={100} value={weights[k]} onChange={e => setWeight(k, Number(e.target.value))} />
							<span className="muted">{weights[k]}</span>
						</div>
					))}
					<div>
						<h2>Status damage and model options</h2>
						<div className="muted">Status damage weights, applied to each channel's per-second value (game value x100) inside offence.</div>
						{(["ion", "disruption", "slowing", "scrambling"] as const).map(k => (
							<div className="slider" key={k}>
								<span>{k} damage</span>
								<input type="range" min={0} max={5} step={0.1} value={adv[k]} onChange={e => setAdv(a => ({ ...a, [k]: Number(e.target.value) }))} />
								<span className="muted">{adv[k]}</span>
							</div>
						))}
						<div className="slider"><span>Movement duty (energy/heat budget)</span>
							<input type="range" min={0} max={1} step={0.05} value={adv.moveDuty} onChange={e => setAdv(a => ({ ...a, moveDuty: Number(e.target.value) }))} />
							<span className="muted">{adv.moveDuty}</span></div>
						<div className="slider"><span>Ammo must last (s)</span>
							<input type="range" min={5} max={300} step={5} value={adv.ammoHorizon} onChange={e => setAdv(a => ({ ...a, ammoHorizon: Number(e.target.value) }))} />
							<span className="muted">{adv.ammoHorizon}</span></div>
						<div className="slider"><span>Battery covers deficit (s)</span>
							<input type="range" min={5} max={120} step={5} value={adv.batteryHorizon} onChange={e => setAdv(a => ({ ...a, batteryHorizon: Number(e.target.value) }))} />
							<span className="muted">{adv.batteryHorizon}</span></div>
					</div>
					</>}
					<details>
						<summary>Search settings</summary>
						<div className="row" style={{ flexWrap: "wrap" }}>
							{([["population", "Population"], ["generations", "Generations"], ["seed", "Seed"], ["stagnation", "Stop after idle"]] as const).map(([k, label]) => (
								<label key={k}>{label}<input type="number" min={1} value={ga[k]} onChange={e => setGa(p => ({ ...p, [k]: Number(e.target.value) }))} /></label>
							))}
							<label>Workers<input type="number" min={0} max={32} value={workers} onChange={e => setWorkers(Number(e.target.value))} /></label>
						</div>
					</details>
				</div>

				<div className="card">
					<div className="row">
						<button className="primary" disabled={!group || running || !outfits.length} onClick={run}>{running ? "Running…" : "Find best loadout"}</button>
						<button disabled={!running} onClick={() => { stop.current = true; }}>Stop</button>
						{last && <span className="muted">gen {last.gen}/{ga.generations} · best {last.best.toFixed(3)} · feasible {(last.feasibleShare * 100).toFixed(0)}%</span>}
					</div>
					<Chart history={history} />
					<ProgressBar max={ga.generations} value={last ? last.gen : 0} done={!running && !!last} />
					<div className="legend">
							<span style={{ color: "var(--c-best)" }}>■ best{last ? ` ${last.best.toFixed(3)}` : ""}</span>
							<span style={{ color: "var(--c-mean)" }}>■ mean{last ? ` ${last.mean.toFixed(3)}` : ""}</span>
							<span style={{ color: "var(--c-div)" }}>■ diversity{last ? ` ${last.diversity.toFixed(2)}` : ""}</span>
							<span>(each line has its own scale)</span>
						</div>
				</div>

				{result && save && group && result.groupId === group.id && <Results result={result} save={save} group={group} outfits={outfits} map={mapData} outfitSets={outfitSets} />}
			</div>
		</div>
	);
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
		return buy.length ? planStops(buy, map, outfitSets, save.visitedPlanets) : null;
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
	const diff = problem.pool.map((p, i) => ({ name: p.name, from: built.baseline[i], to: pick.genome[i] })).filter(d => d.from !== d.to);
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
