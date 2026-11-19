# Source

Copied from [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/react-best-practices)
at commit `1a2c79d` (MIT, see SKILL.md). Markdown only: no scripts. The upstream README and rule
template were left out (they are for editing the skill itself).

This dashboard is a plain React app bundled by esbuild into one offline HTML file, so the
Next.js, server (RSC), SWR and bundle-splitting rules don't apply here. The useful parts are
the `rerender-*`, `rendering-*`, `js-*` and `advanced-*` rules.
