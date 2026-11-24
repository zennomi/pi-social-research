import { readFileSync } from "node:fs";

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8"));
}
