/**
 * K65-01 (01-B) child-process driver: runs the REAL `validateManifestFile` against a package root
 * given on argv and prints its verdict as JSON.
 *
 * It is a separate process so the 01-B claim is execution-based: if the validator ever imported the
 * package entry, the entry's top-level side effect would land in the artifact file of THAT process,
 * and the parent would observe a non-zero heartbeat count. The driver deliberately never references
 * the entry itself — nothing here is allowed to touch it.
 *
 * Run: node tests/next65/fixtures/packages/validate-driver.mjs <packageRoot>
 */
import { validateManifestFile } from '../../../../dist/plugins/manifest.js';

const [root] = process.argv.slice(2);
if (!root) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'missing <packageRoot>' }) + '\n');
  process.exit(2);
}
const result = validateManifestFile(root);
process.stdout.write(JSON.stringify({
  ok: result.ok,
  issues: result.issues,
  packageId: result.manifest?.packageId ?? null,
  entries: result.manifest?.plugins?.map(plugin => plugin.entry) ?? [],
}) + '\n');
