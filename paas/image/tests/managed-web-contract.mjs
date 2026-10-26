import assert from "node:assert/strict";
import { readFileSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

export const contract = JSON.parse(readFileSync(new URL("./managed-web-contract.json", import.meta.url), "utf8"));

export function verifyWebManifest(pkg, web) {
  assert.equal(pkg.name, "@woowtech/pi-paseo");
  assert.equal(pkg.version, contract.paseoVersion, "candidate must contain the managed-web Paseo release");
  for (const [key, value] of Object.entries(contract.webClient)) {
    assert.equal(web[key], value, `managed web ${key} differs from reviewed artifact`);
  }
}

export function verifyCompiledRoute(piWebDir) {
  const server = join(piWebDir, ".next/server");
  const routes = JSON.parse(readFileSync(join(server, "app-paths-manifest.json"), "utf8"));
  const route = routes["/paseo-web/[[...path]]/route"];
  assert.equal(route, "app/paseo-web/[[...path]]/route.js", "managed web must be a real production route");
  accessSync(join(server, route), constants.R_OK);
  return route;
}
