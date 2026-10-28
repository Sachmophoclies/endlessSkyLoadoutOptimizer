import { useEffect, useRef, useState } from "react";

const FILL_MS = 400;

// Search progress. While running it tracks `value`; once the run is `done` it eases the remaining distance to full.
export function ProgressBar({ value, max, done }: { value: number; max: number; done: boolean }) {
	const [shown, setShown] = useState(value);
	const shownRef = useRef(value);
	shownRef.current = shown;
	useEffect(() => {
		if(!done || value === 0)
		{
			setShown(value);
			return;
		}
		const from = shownRef.current, start = performance.now();
		let frame = 0;
		const tick = (now: number): void => {
			const t = Math.min(1, (now - start) / FILL_MS);
			setShown(from + (max - from) * (1 - (1 - t) ** 3));
			if(t < 1)
				frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [value, max, done]);
	return <progress className="bar" max={max} value={shown} aria-label="Search progress" />;
}
