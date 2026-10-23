import { writeFileSync } from "node:fs";
import { pool } from "../lib/db/index.ts";
import { renderPng } from "../lib/desk-map.ts";
import { utcToday } from "../lib/time.ts";

const date = process.argv[2] ?? utcToday();
const output = process.argv[3] ?? `desk-map-${date}.png`;
writeFileSync(output, await renderPng(date));
console.log(`wrote ${output}`);
await pool().end();
