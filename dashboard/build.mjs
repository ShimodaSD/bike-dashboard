// Builds a single self-contained dashboard.html (React bundled inline, no internet needed).
//   pnpm install && pnpm build
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const r = await build({
  entryPoints: ['src/app.jsx'], bundle: true, minify: true, write: false,
  format: 'iife', target: 'es2019', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('src/style.css', 'utf8');
// Sprint b logo as the tab icon, inlined so the page stays a single offline file.
const icon = 'data:image/svg+xml,' + encodeURIComponent(readFileSync('src/brand/logo.svg', 'utf8').trim());
writeFileSync("dashboard.html", `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Bike Live Training</title>
<link rel="icon" type="image/svg+xml" href="${icon}">
<!-- Generated file. Edit dashboard/src/, then run: cd dashboard && pnpm build -->
<style>
${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`);
console.log("dashboard.html", (js.length / 1024).toFixed(0), 'KB js');
