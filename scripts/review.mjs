#!/usr/bin/env node
// Dogfood: Jev reviews this package before publish. Run: npm run review
import { readFileSync } from "node:fs";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is not set. Get a key at https://console.typesafe.ai/keys");
  process.exit(2);
}

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const state = {
  "index.js": read("../index.js"),
  "README.md": read("../README.md"),
  "package.json": read("../package.json"),
};

const questions = {
  mcp_correct: {
    type: "noul",
    instructions:
      "Does `index.js` correctly implement an MCP stdio server exposing the evaluate tool as a pass-through to POST /v1/systemone?",
  },
  docs_accurate: {
    type: "noul",
    instructions:
      "Does `README.md` accurately describe installation and usage, consistent with `index.js` and `package.json`?",
  },
  no_secrets: {
    type: "noul",
    instructions: "Is this package free of hardcoded secrets, API keys, and sensitive data?",
  },
  publish_ready: {
    type: "score",
    instructions: "Overall, how ready is this package to publish to npm?",
    criteria: ["not ready: real defects or misleading docs", "ready with minor nits", "ready to ship"],
  },
};

const res = await fetch("https://api.typesafe.ai/v1/systemone", {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ state, model: "jev-latest", questions }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`TypeSafe API error ${res.status}:`, JSON.stringify(body));
  process.exit(2);
}

console.log(JSON.stringify(body.answers, null, 2));

const fail =
  body.answers.no_secrets.noul < 0.5 ||
  body.answers.mcp_correct.noul < 0.5 ||
  body.answers.docs_accurate.noul < 0.5;
console.log(fail ? "\nJev review: FAIL" : "\nJev review: PASS");
process.exit(fail ? 1 : 0);
