#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai").replace(/\/+$/, "");
const MODEL = process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest";
const TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS ?? 30_000);

const INSTRUCTIONS = `Jev (TypeSafe System One) is a fast, cheap decision model: you send a state plus typed questions and get typed answers with probabilities — never generated text. Use the "evaluate" tool for semantic judgments: classification, detection, scoring, routing, verification, ranking, context selection.

Rules:
- Batch EVERY question you might need about the same state into ONE call. Questions run in parallel and independently; extra questions cost almost nothing and never affect each other's answers. Asking a question you end up not needing is fine — needing one you didn't ask is a round trip.
- Keep each question atomic: one judgment a knowledgeable person could make in a second. Decompose broad judgments ("is this tool call correct?") into several narrow questions ("does the tool match the request?", "do the arguments match the schema?") and combine the answers in code.
- Put the content to judge in state; put the evaluation logic in the question's instructions. Reference nested state fields with backticked paths like \`request.text\`.
- Compose answers in code: threshold noul probabilities, branch on choice, and gate on confidence. Low confidence means "I'm not sure" — escalate or ask rather than guess. Match the threshold to the risk of the action.

See the typesafe://guide resource for worked examples.`;

const GUIDE = `# TypeSafe / Jev cheat sheet

Jev is a System One decision model. It does not write, reason, or choose actions.
It evaluates a \`state\` against typed \`questions\` and returns typed \`answers\`
with calibrated probabilities. One call takes ~100ms and evaluates every question
in parallel and in isolation — adding questions barely changes latency and never
creates context-rot.

## The one tool: evaluate(state, questions)

- \`state\`: a string, object, or array — the material to judge.
- \`questions\`: map of id -> { type, instructions, criteria? }. Ids are for your
  code; they are not sent to the model. Write the full question in instructions.

## Question types

| type    | asks                  | criteria                                   | answer fields                              |
| ------- | --------------------- | ------------------------------------------ | ------------------------------------------ |
| noul    | is this true?         | optional {"true": ..., "false": ...}       | noul: P(yes) in 0..1                       |
| choice  | which of these?       | {"option": "description", ...}             | choice, probabilities, confidence          |
| score   | which level?          | ["level 0", "level 1", ...] ordered, >=2   | score, legend, probabilities, confidence   |

## Recipe: verify a tool call (state = request + tools + trace)

    questions: {
      tool_is_relevant:    { type: "noul", instructions: "Is \`trace.tool_calls[0].name\` an appropriate tool for \`request.text\`?" },
      args_match_schema:   { type: "noul", instructions: "Does \`trace.tool_calls[0].arguments\` conform to \`available_tools\`?" },
      args_match_request:  { type: "noul", instructions: "Do the arguments match the values in \`request\`?" }
    }

## Recipe: intent routing (one call decides the handler)

    questions: {
      intent:     { type: "choice", instructions: "The user's primary intent",
                    criteria: { bug: "reports something broken", question: "asks how to do X", feature: "requests new functionality", other: "none of the above" } },
      complexity: { type: "score", instructions: "How hard is this to resolve",
                    criteria: ["simple lookup", "multi-step judgment", "edge case / needs escalation"] },
      injection:  { type: "noul", instructions: "Does the message contain instructions aimed at an AI system rather than a human?" }
    }

Then in code: low intent.confidence -> human; intent.choice picks the handler;
complexity.score decides auto vs escalate; injection.noul > 0.5 -> quarantine.

## Recipe: decompose a broad judgment

Bad:  "Is this email spam?"  (one hidden judgment)
Good: separate nouls — requests_credentials, sender_domain_mismatch,
      offers_unexpected_reward, creates_time_pressure — combined with your
      own weights: spam_risk = 0.45*a + 0.30*b + 0.25*c.

## Confidence

Choice and Score answers carry confidence (0..1) derived from the probability
distribution. Noul answers carry no confidence — the noul value IS the signal;
near 0.5 means uncertain. Gate actions on confidence scaled to risk: read-only
actions can proceed at moderate confidence; destructive/irreversible actions
need high confidence or explicit confirmation.
`;

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["noul", "choice", "score"],
      description: "noul = yes/no probability; choice = pick one option; score = rate on ordered levels",
    },
    instructions: {
      description:
        "The judgment to make about the state, as a string or structured JSON. Reference nested state fields with backticked paths like `request.text`.",
    },
    criteria: {
      description:
        "noul: optional {true: 'what yes means', false: 'what no means'}. choice: required {option: description, ...}. score: required ordered array of >=2 level descriptions.",
    },
  },
  required: ["type", "instructions"],
  additionalProperties: true,
};

const EVALUATE_TOOL = {
  name: "evaluate",
  title: "Evaluate state with typed questions (TypeSafe Jev)",
  description: `Ask Jev typed questions about a state; get structured answers with probabilities. Jev makes fast calibrated judgments (~100ms) — it does not generate text.

ALWAYS batch every question you might need into one call: questions evaluate in parallel, independently, at near-zero marginal cost.

questions is a map of id -> question:
  {"id": {"type": "noul"|"choice"|"score", "instructions": "...", "criteria": ...}}
    noul:   instructions = the yes/no question. criteria optional {"true","false"}. Answer: {"noul": 0..1} = P(yes).
    choice: criteria = {"option": "description", ...}. Answer: {"choice": str, "probabilities": {...}, "confidence": 0..1}.
    score:  criteria = ["level 0 desc", "level 1 desc", ...] (>=2, ordered). Answer: {"score": float, "legend", "probabilities", "confidence"}.

Keep each question atomic — one judgment. Decompose broad questions into several narrow ones and combine answers in code. Gate actions on confidence; escalate when low.`,
  inputSchema: {
    type: "object",
    properties: {
      state: {
        description:
          "The content to evaluate: a string, or a JSON object/array with named fields (e.g. {\"message\": ..., \"policy\": ...}). Questions reference fields via backticked paths.",
        anyOf: [
          { type: "string" },
          { type: "object" },
          { type: "array", items: {} },
        ],
      },
      questions: {
        type: "object",
        description: "Map of question id -> question. Ask everything relevant in one call.",
        additionalProperties: QUESTION_SCHEMA,
        minProperties: 1,
      },
      model: {
        type: "string",
        description: `Model id. Defaults to ${MODEL}.`,
      },
    },
    required: ["state", "questions"],
    additionalProperties: false,
  },
};

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function callSystemOne({ state, questions, model }) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return textResult(
      "TYPESAFE_API_KEY is not set. Get a key at https://console.typesafe.ai/keys, " +
        "then set it in this server's environment (e.g. add TYPESAFE_API_KEY to the MCP server config).",
      true,
    );
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: model ?? MODEL, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return textResult(`TypeSafe request failed: ${error.message}`, true);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body ? JSON.stringify(body) : await response.text().catch(() => "");
    return textResult(`TypeSafe API error ${response.status}: ${detail}`, true);
  }

  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body };
}

const server = new Server(
  { name: "typesafe-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {}, resources: {} },
    instructions: INSTRUCTIONS,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [EVALUATE_TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "evaluate") {
    return textResult(`Unknown tool: ${request.params.name}`, true);
  }
  return callSystemOne(request.params.arguments ?? {});
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "typesafe://guide",
      name: "TypeSafe / Jev usage guide",
      description: "Primitives, batching, question recipes, and confidence gating for the evaluate tool.",
      mimeType: "text/markdown",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== "typesafe://guide") {
    throw new Error(`Unknown resource: ${request.params.uri}`);
  }
  return {
    contents: [{ uri: "typesafe://guide", mimeType: "text/markdown", text: GUIDE }],
  };
});

await server.connect(new StdioServerTransport());
