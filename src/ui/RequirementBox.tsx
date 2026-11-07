import { useEffect, useMemo, useState } from "react";
import type { OutfitData } from "../../data-prep/src/types.ts";
import { type Requirement, requirementLabel } from "../core/model.ts";

// Not worth picking: ore and license items are not fitted, and hand-to-hand gear is left out of the search.
const HIDDEN_CATEGORIES = new Set(["Minerals", "Licenses", "Hand to Hand", "Unique", "Special"]);
const ABILITIES = "Abilities";
const EQUIPPED = "Currently equipped";

export interface Ability {
	name: string;
	disabled?: boolean; // e.g. an access attribute that nothing you have reached provides
}

interface Props {
	title: string;
	items: Requirement[];
	onChange: (items: Requirement[]) => void;
	counted: boolean; // outfits carry a number of copies each
	outfits: OutfitData[];
	abilities: Ability[];
	equipped?: string[]; // names of the outfits the selected ship group carries
}

export function RequirementBox({ title, items, onChange, counted, outfits, abilities, equipped = [] }: Props) {
	const [open, setOpen] = useState(false);

	function add(r: Requirement): void {
		setOpen(false);
		const at = items.findIndex(i => i.kind === r.kind && i.name === r.name);
		if(at < 0)
			onChange([...items, r]);
		else if(counted && r.kind === "outfit")
			onChange(items.map((i, k) => (k === at ? { ...i, count: i.count + 1 } : i)));
	}

	return (
		<div className="card req">
			<div className="req-head">
				<h2>{title}</h2>
				<button type="button" className="req-add" title={`Add to ${title.toLowerCase()}`} onClick={() => setOpen(true)}>+</button>
			</div>
			{items.map((r, k) => (
				<div key={`${r.kind}/${r.name}`} className="req-row">
					<span className="req-name">{requirementLabel(r)}</span>
					{counted && r.kind === "outfit" && <>
						<button type="button" aria-label="Fewer" disabled={r.count <= 1}
							onClick={() => onChange(items.map((i, j) => (j === k ? { ...i, count: i.count - 1 } : i)))}>−</button>
						<span className="req-count">{r.count}</span>
						<button type="button" aria-label="More"
							onClick={() => onChange(items.map((i, j) => (j === k ? { ...i, count: i.count + 1 } : i)))}>+</button>
					</>}
					<button type="button" aria-label="Remove" title="Remove" onClick={() => onChange(items.filter((_, j) => j !== k))}>✕</button>
				</div>
			))}
			{open && <Picker outfits={outfits} abilities={abilities} equipped={equipped} onPick={add} onClose={() => setOpen(false)} />}
		</div>
	);
}

function Picker({ outfits, abilities, equipped, onPick, onClose }: {
	outfits: OutfitData[]; abilities: Ability[]; equipped: string[]; onPick: (r: Requirement) => void; onClose: () => void;
}) {
	const byCategory = useMemo(() => {
		const m = new Map<string, string[]>();
		for(const o of outfits)
		{
			if(HIDDEN_CATEGORIES.has(o.category) || (o.attributes.installable ?? 0) < 0)
				continue;
			const category = o.category === "Turret" ? "Turrets" : o.category;
			const list = m.get(category) ?? m.set(category, []).get(category)!;
			if(!list.includes(o.name))
				list.push(o.name);
		}
		return new Map([...m].sort(([a], [b]) => a.localeCompare(b)).map(([c, names]) => [c, names.sort((a, b) => a.localeCompare(b))]));
	}, [outfits]);
	const carried = useMemo(() => {
		const have = new Set(equipped);
		return [...byCategory.values()].flat().filter(n => have.has(n)).sort((a, b) => a.localeCompare(b));
	}, [byCategory, equipped]);
	const categories = [...(carried.length ? [EQUIPPED] : []), ...(abilities.length ? [ABILITIES] : []), ...byCategory.keys()];
	const [category, setCategory] = useState(categories[0] ?? "");
	const [filter, setFilter] = useState("");

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => e.key === "Escape" ? onClose() : undefined;
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const needle = filter.trim().toLowerCase();
	return (
		<div className="modal" onClick={onClose}>
			<div className="modal-panel" role="dialog" onClick={e => e.stopPropagation()}>
				<div className="modal-cats">
					{categories.map(c => (
						<button key={c} type="button" aria-pressed={c === category} onClick={() => { setCategory(c); setFilter(""); }}>{c}</button>
					))}
				</div>
				<div className="modal-items">
					<div className="modal-top">
						<input type="search" placeholder="Filter" autoFocus value={filter} onChange={e => setFilter(e.target.value)} />
						<button type="button" aria-label="Close" onClick={onClose}>✕</button>
					</div>
					<div className="modal-list">
						{category === ABILITIES
							? abilities.filter(a => a.name.toLowerCase().includes(needle)).map(a => {
								const r: Requirement = { kind: "attribute", name: a.name, count: 1 };
								return <button key={a.name} type="button" disabled={a.disabled} title={a.disabled ? "Not reached yet" : undefined} onClick={() => onPick(r)}>{requirementLabel(r)}</button>;
							})
							: (category === EQUIPPED ? carried : byCategory.get(category) ?? []).filter(n => n.toLowerCase().includes(needle)).map(n => (
								<button key={n} type="button" onClick={() => onPick({ kind: "outfit", name: n, count: 1 })}>{n}</button>
							))}
					</div>
				</div>
			</div>
		</div>
	);
}
