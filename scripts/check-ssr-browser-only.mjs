/**
 * 服务端产物里不许出现只能在浏览器里跑的包。
 *
 * Leaflet 在**模块顶层**就读 `window`。任何被服务端渲染的模块 import 到它，页面就是一个
 * `ReferenceError: window is not defined` —— 而且不是构建期报错，是**运行时**每个请求都
 * 报，本地 `bun run build` 一声不吭。
 *
 * 这个错犯过两次：can-radar 一次，这里一次（`mapBase.ts` 顶上加了一行 `import L` ，而
 * `Airports.vue`／`Fixes.vue` 只是为了 `firColor` 才 import 它，那两个是服务端渲染的）。
 * 所以规矩写成检查：需要 Leaflet 的东西只许放在 `src/lib/mapMarkers.ts`，只许
 * `client:only` 的岛屿 import。
 *
 * 只看**静态 import**。客户端资源清单里出现 `leaflet-src.xxxx.js` 这样的文件名是正常
 * 的 —— 那是给浏览器加载的那一份。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "dist/server";
const BROWSER_ONLY = ["leaflet"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith(".mjs") || name.endsWith(".js")) out.push(path);
  }
  return out;
}

let files;
try {
  files = walk(ROOT);
} catch {
  console.error(`check-ssr: ${ROOT} 不在 —— 先跑 astro build`);
  process.exit(2);
}

const offenders = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const pkg of BROWSER_ONLY) {
    const staticImport = new RegExp(
      `(?:import|export)[^;\\n]*?from\\s*['"]${pkg}(?:/[^'"]*)?['"]`,
    );
    const bareImport = new RegExp(`import\\s*['"]${pkg}(?:/[^'"]*)?['"]`);
    if (staticImport.test(source) || bareImport.test(source)) {
      offenders.push(`${file} → ${pkg}`);
    }
  }
}

if (offenders.length) {
  console.error(
    "check-ssr: 服务端产物 import 了只能在浏览器里跑的包，" +
      "页面会在运行时炸 window is not defined：",
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    "\n修法：把需要它的代码挪进 src/lib/mapMarkers.ts 之类只给 client:only 岛屿用的模块。",
  );
  process.exit(1);
}

console.log(`check-ssr: ${files.length} 个服务端产物，没有浏览器专用包 ✓`);
