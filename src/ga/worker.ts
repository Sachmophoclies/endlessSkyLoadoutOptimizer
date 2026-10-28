/// <reference lib="webworker" />
import type { Problem } from "../core/model.ts";
import { evaluate } from "../core/stats.ts";

// Messages: {type:"init", problem} once, then {type:"eval", id, genomes} -> {id, results}.
let problem: Problem | null = null;

self.onmessage = (e: MessageEvent) => {
	const msg = e.data;
	if(msg.type === "init")
		problem = msg.problem;
	else if(msg.type === "eval" && problem)
	{
		const results = (msg.genomes as Int16Array[]).map(g => evaluate(problem!, g));
		(self as unknown as Worker).postMessage({ id: msg.id, results });
	}
};
