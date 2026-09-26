import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('./presentation-preview.mjs',import.meta.url));
await build({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',target:'safari17',outfile:fileURLToPath(new URL('../management/ui/presentation-preview.js',import.meta.url)),legalComments:'eof'});
