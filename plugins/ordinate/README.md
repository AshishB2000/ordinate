# The Ordinate plugin

Skills and the MCP connection for an agent that works **inside an Ordinate server**: building
dashboards and answering data questions over your company's Ordinate, the same way a person
would in the app. Every figure comes from Ordinate's engine, never from the model.

This is the product plugin, for people who use Ordinate. The skills for developing Ordinate
itself live in `.claude/skills/` at the repo root.

| Skill | Use it for |
|---|---|
| `build-dashboard` | "Build me a sales dashboard": finds the data, writes a plan, builds it as a draft with `create_dashboard`, reports anything Ordinate dropped, and publishes it with `publish_dashboard` only when you say so. |
| `answer-data-questions` | "Which region is most profitable?": picks the tool that computes the answer, and quotes the server's figures without changing them. |

## Install (Claude Code)

1. In Ordinate, open **API tokens** (`/tokens`) and make a personal token (`ord_…`). It acts as
   you, with your current role: the agent sees only the projects you can read, and can only
   create visuals and dashboards, and publish or unpublish dashboards, where you are an editor.
2. In Claude Code:

   ```
   /plugin marketplace add AshishB2000/ordinate
   /plugin install ordinate@ordinate
   ```

   When the plugin is enabled, Claude Code asks for your **Ordinate address** (for example
   `https://bi.example.com`, no trailing slash) and your **personal API token**. The address is
   saved in your Claude Code settings; the token goes to your system's credential store, never
   to a file.

The plugin's `plugin.json` connects to `<address>/api/mcp` with `Authorization: Bearer <token>`.
The tools are listed in [`docs/automation.md`](../../docs/automation.md). They are read-only
except `create_visual`, `create_dashboard`, `publish_dashboard` and `unpublish_dashboard`, which
save records, never data. A dashboard the agent builds is a draft until it is published, which
makes it visible to everyone in the project.

## Other agents

The skills are plain `SKILL.md` files. Any agent that can load skills and reach an MCP endpoint
with a bearer token can use them: point it at `https://<your host>/api/mcp`, send the token as
`Authorization: Bearer ord_…`, and give it the two skill folders.

## Keeping it honest

`scripts/test-pluginSkills.ts` builds `build-dashboard`'s example plan against the bundled
sample project, and fails if anything is dropped. It also checks that the skill's chart-type
list matches the app's. Change the skills and the validator together.
