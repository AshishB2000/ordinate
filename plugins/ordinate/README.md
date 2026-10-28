# The Ordinate plugin

Skills and the MCP connection for an agent that works **inside an Ordinate server**: building
dashboards and answering data questions over your company's Ordinate, the same way a person
would in the app. Every figure comes from Ordinate's engine, never from the model.

This is the product plugin, for people who use Ordinate. The skills for developing Ordinate
itself live in `.claude/skills/` at the repo root.

| Skill | Use it for |
|---|---|
| `build-dashboard` | "Build me a sales dashboard": finds the data, writes a plan, builds it with `create_dashboard`, and reports anything Ordinate dropped. |
| `answer-data-questions` | "Which region is most profitable?": picks the tool that computes the answer, and quotes the server's figures without changing them. |

## Install (Claude Code)

1. In Ordinate, open **API tokens** (`/tokens`) and make a personal token (`ord_…`). It acts as
   you, with your current role: the agent sees only the projects you can read, and can only
   create visuals and dashboards where you are an editor.
2. Before starting Claude Code, set:

   ```bash
   export ORDINATE_URL=https://bi.example.com   # your Ordinate address, no trailing slash
   export ORDINATE_TOKEN=ord_…
   ```

   Keep the token in your shell profile or secret manager, never in a file in a repo.
3. In Claude Code:

   ```
   /plugin marketplace add AshishB2000/ordinate
   /plugin install ordinate@ordinate
   ```

`.mcp.json` connects to `${ORDINATE_URL}/api/mcp` with `Authorization: Bearer ${ORDINATE_TOKEN}`.
The tools are listed in [`docs/automation.md`](../../docs/automation.md). They are read-only
except `create_visual` and `create_dashboard`, which save records, never data.

## Other agents

The skills are plain `SKILL.md` files. Any agent that can load skills and reach an MCP endpoint
with a bearer token can use them: point it at `https://<your host>/api/mcp`, send the token as
`Authorization: Bearer ord_…`, and give it the two skill folders.

## Keeping it honest

`scripts/test-pluginSkills.ts` builds `build-dashboard`'s example plan against the bundled
sample project, and fails if anything is dropped. It also checks that the skill's chart-type
list matches the app's. Change the skills and the validator together.
