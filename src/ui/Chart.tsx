import { useEffect, useRef } from "react";
import type { Progress } from "../ga/ga.ts";

// Convergence chart: best and mean fitness and population diversity (0..1).
// Best and mean each get their own vertical range so small late improvements stay visible.
export function Chart({ history }: { history: Progress[] }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = ref.current;
		const ctx = canvas?.getContext("2d");
		if(!canvas || !ctx)
			return;
		const w = canvas.width, h = canvas.height;
		const style = getComputedStyle(canvas);
		ctx.clearRect(0, 0, w, h);
		ctx.strokeStyle = style.getPropertyValue("--grid") || "#8884";
		ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
		if(history.length < 2)
			return;
		const scaled = (values: number[]) => {
			const lo = Math.min(...values), span = Math.max(...values) - lo || 1;
			return (v: number) => h - 6 - ((v - lo) / span) * (h - 12);
		};
		const x = (i: number) => 4 + (i / (history.length - 1)) * (w - 8);
		const line = (values: number[], color: string, y: (v: number) => number) => {
			ctx.beginPath();
			values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
			ctx.strokeStyle = color;
			ctx.lineWidth = 2;
			ctx.stroke();
		};
		const means = history.map(p => p.mean), bests = history.map(p => p.best);
		line(means, style.getPropertyValue("--c-mean") || "#888", scaled(means));
		line(bests, style.getPropertyValue("--c-best") || "#2a7", scaled(bests));
		line(history.map(p => p.diversity), style.getPropertyValue("--c-div") || "#c60", v => h - 6 - v * (h - 12));
	}, [history]);
	return <canvas ref={ref} width={640} height={180} className="chart" aria-label="Convergence chart" />;
}
