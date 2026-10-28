import type { EvalResult, Genome, Problem } from "../core/model.ts";
import { evaluate } from "../core/stats.ts";
import type { Evaluator } from "./ga.ts";

export interface EvalPool {
	evaluate: Evaluator;
	size: number;
	close(): void;
}

// Parallel evaluation: the orchestrator splits each generation's population into chunks, one per worker.
// With 0 workers (or if workers cannot start) evaluation runs in the calling thread.
export function createPool(problem: Problem, workers: number): EvalPool {
	if(workers <= 0 || typeof Worker === "undefined")
		return { size: 0, close() {}, evaluate: async genomes => genomes.map(g => evaluate(problem, g)) };

	const threads: Worker[] = [];
	for(let i = 0; i < workers; ++i)
	{
		const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
		w.postMessage({ type: "init", problem });
		threads.push(w);
	}
	let nextId = 0;

	const run = (w: Worker, genomes: Genome[]): Promise<EvalResult[]> => new Promise((resolve, reject) => {
		const id = nextId++;
		const onMessage = (e: MessageEvent): void => {
			if(e.data.id !== id)
				return;
			w.removeEventListener("message", onMessage);
			resolve(e.data.results);
		};
		w.addEventListener("message", onMessage);
		w.addEventListener("error", reject, { once: true });
		w.postMessage({ type: "eval", id, genomes });
	});

	return {
		size: workers,
		close: () => threads.forEach(w => w.terminate()),
		evaluate: async genomes => {
			const chunk = Math.ceil(genomes.length / threads.length);
			const parts = await Promise.all(threads.map((w, i) => {
				const slice = genomes.slice(i * chunk, (i + 1) * chunk);
				return slice.length ? run(w, slice) : Promise.resolve([] as EvalResult[]);
			}));
			return parts.flat();
		},
	};
}
