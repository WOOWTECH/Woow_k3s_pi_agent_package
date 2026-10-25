#!/usr/bin/env node
// Keep the shared skills/MCP bridge, but never install a missing engine merely
// because Omnigent opens its first setup conversation. Explicit opt-in remains.
import fs from 'node:fs';
const file = process.argv[2];
let source = fs.readFileSync(file, 'utf8');
const marker = 'PI_SHARED_INSTALL_MISSING_CLI';
if (!source.includes(marker)) {
  const install = "      if (!binary) {\n        const npm = commandPath('npm');";
  const profiles = "    const recorded = loc.state ? readJSON(path.join(loc.state, 'clis.json')) : {};";
  for (const needle of [install, profiles]) {
    if (source.split(needle).length !== 2) throw Error('Shared runtime discovery patch anchor changed');
  }
  source = source.replace(install, `      if (!binary && process.env.${marker} !== '1') {
        result[name] = { status: 'not-installed', installed: false };
        continue;
      }
` + install).replace(profiles, profiles + "\n    if (!recorded[name]?.binary) continue;");
  fs.writeFileSync(file, source);
}
