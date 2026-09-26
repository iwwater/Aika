// Show the local binding reference without reading credential contents.
import {realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
const path=process.argv[2];
if(!path||!isAbsolute(path))throw Error('Supply an absolute path to your existing external DashScope credential file.');
const actual=await realpath(path),info=await stat(actual);
if(!info.isFile()||(info.mode&0o077)!==0||info.uid!==process.getuid())throw Error('Expected your own mode0600 credential file.');
console.log('dashscope-'+createHash('sha256').update(actual).digest('hex').slice(0,12));
