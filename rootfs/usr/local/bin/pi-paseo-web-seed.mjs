// Install only static client data, using the exact package's checksum, build
// identity and safe-extraction checks. A local image archive replaces network
// fetches; the normal activation sees the same installed receipt and paths.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export async function seedWebClient({
  bundle = process.env.PI_PASEO_PLUGIN_ROOT || '/opt/woow/pi-paseo-plugin',
  archive = process.env.PI_PASEO_WEB_ARCHIVE || '/opt/woow/pi-paseo-web/client.tar.gz',
  loc,
} = {}) {
  const { locations, assertSafePath } = await import(pathToFileURL(path.join(bundle, 'src/state.mjs')));
  const { ensureWebClient, webClientStatus } = await import(pathToFileURL(path.join(bundle, 'src/web-client.mjs')));
  loc ??= locations();
  // Warm startup does not require the archive and never replaces a valid cache.
  if (webClientStatus(loc).ready) return webClientStatus(loc);
  if (!assertSafePath(archive)?.isFile()) throw Error('Paseo web image archive is missing');
  return ensureWebClient(loc, {
    fetchImpl: async () => new Response(Readable.toWeb(fs.createReadStream(archive))),
  });
}
