import { resolve } from 'node:path';
import { restrictPrivatePathSync, isPrivateFileSync } from '../dist/core/platform-files.js';
const file = process.argv[2];
if (!file) throw Error('Usage: node tools/private-file.mjs path-to-your-credential-file');
restrictPrivatePathSync(resolve(file));
if (!isPrivateFileSync(resolve(file))) throw Error('The file is not private.');
console.log('File access is restricted to its owner (plus Windows SYSTEM and Administrators).');
