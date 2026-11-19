#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { handlers } from "../dist/handlers.js";

const tools = JSON.parse(readFileSync(new URL("../src/tools.json", import.meta.url), "utf8")).tools.map((t) => t.name);
const names = Object.keys(handlers);
const noHandler = tools.filter((t) => !names.includes(t));
const noTool = names.filter((n) => !tools.includes(n));
if (noHandler.length) console.error(`Tools with no handler: ${noHandler.join(", ")}`);
if (noTool.length) console.error(`Handlers with no tool: ${noTool.join(", ")}`);
if (noHandler.length || noTool.length) process.exit(1);
console.log(`Every one of the ${tools.length} tools has a handler, and every handler a tool.`);
