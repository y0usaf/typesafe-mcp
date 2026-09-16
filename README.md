# typesafe-mcp

MCP server for [TypeSafe](https://docs.typesafe.ai) Jev — typed decisions
(choice / score / noul) with probabilities, callable as one tool.

## Install

```bash
claude mcp add typesafe -e TYPESAFE_API_KEY=... -- npx -y @y0usaf/typesafe-mcp
```

Or any MCP config:

```json
{ "mcpServers": { "typesafe": { "command": "npx", "args": ["-y", "@y0usaf/typesafe-mcp"], "env": { "TYPESAFE_API_KEY": "..." } } } }
```

Get a key: https://console.typesafe.ai/keys

## Use

One tool: `evaluate(state, questions)`. The server teaches your agent how to
use it — batching, atomic questions, and confidence gating are built into the
instructions, tool schema, and the `typesafe://guide` resource.
