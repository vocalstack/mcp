#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handlers } from "../dist/handlers.js";

export const PENDING = ["transcribe", "restore_transcription", "save_speaker", "delete_speaker"];

export const RETIRED = [
  "transcribe_url",
  "transcribe_file",
  "wait_for_transcription",
  "translate_transcription",
  "search_by_meaning",
  "get_broadcast",
  "list_voices",
];

export function check(tools, names = Object.keys(handlers), pending = PENDING, retired = RETIRED) {
  const problems = [];
  const noHandler = tools.filter((t) => !names.includes(t) && !retired.includes(t));
  const noTool = names.filter((n) => !tools.includes(n) && !pending.includes(n));
  const landed = pending.filter((n) => tools.includes(n));
  const stray = pending.filter((n) => !names.includes(n));
  const gone = retired.filter((n) => !tools.includes(n));
  const kept = retired.filter((n) => names.includes(n));
  if (noHandler.length) problems.push(`Tools with no handler: ${noHandler.join(", ")}`);
  if (noTool.length) problems.push(`Handlers with no tool: ${noTool.join(", ")}`);
  if (landed.length) problems.push(`Now in tools.json, remove from PENDING in scripts/check-handlers.mjs: ${landed.join(", ")}`);
  if (stray.length) problems.push(`In PENDING with no handler: ${stray.join(", ")}`);
  if (gone.length) problems.push(`No longer in tools.json, remove from RETIRED in scripts/check-handlers.mjs: ${gone.join(", ")}`);
  if (kept.length) problems.push(`In RETIRED but still handled: ${kept.join(", ")}`);
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tools = JSON.parse(readFileSync(new URL("../src/tools.json", import.meta.url), "utf8")).tools.map((t) => t.name);
  const problems = check(tools);
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  const waiting = PENDING.length ? ` (${PENDING.length} more handled ahead of the hosted release: ${PENDING.join(", ")})` : "";
  const leaving = RETIRED.length ? ` (${RETIRED.length} listed until the hosted release drops them, with no handler: ${RETIRED.join(", ")})` : "";
  console.log(`Every one of the ${tools.length} tools has a handler, and every handler a tool${waiting}${leaving}.`);
}
