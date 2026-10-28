// Usage: node src/main.ts [gameDataDir] [outDir]
// Defaults: ../../endlessSkySource/data -> ../public/data (relative to this file).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGameData } from "./gameData.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const dataDir = resolve(process.argv[2] ?? join(here, "..", "..", "..", "endlessSkySource", "data"));
const outDir = resolve(process.argv[3] ?? join(here, "..", "..", "public", "data"));

const game = loadGameData(dataDir);
mkdirSync(outDir, { recursive: true });

const sorted = <T extends { name: string }>(map: Map<string, T>): T[] =>
	[...map.values()].sort((a, b) => a.name.localeCompare(b.name));

const write = (file: string, value: unknown): void =>
	writeFileSync(join(outDir, file), JSON.stringify(value));

write("ships.json", sorted(game.ships));
write("outfits.json", sorted(game.outfits));
write("outfitters.json", game.outfitters);
write("planets.json", game.planetSources);
write("map.json", game.map);

const outfits = [...game.outfits.values()];
const weapons = outfits.filter(o => o.weapon);
console.log(`ships: ${game.ships.size}`);
console.log(`outfits: ${outfits.length} (${outfits.filter(o => o.sold).length} sold, ${weapons.length} weapons, ` +
	`${weapons.filter(o => o.weapon!.instantaneous).length} instantaneous)`);
console.log(`outfitter sets: ${Object.keys(game.outfitters.sets).length} (${game.outfitters.reachable.length} reachable)`);
console.log(`wrote ${outDir}`);
