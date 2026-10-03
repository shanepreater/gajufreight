#!/usr/bin/env node
// Opens the local wireframe index in the default browser (no server needed).
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const index = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/wireframes/index.html');
const url = pathToFileURL(index).href;
const opener = { darwin: ['open', [url]], win32: ['cmd', ['/c', 'start', '', url]] }[process.platform] ?? ['xdg-open', [url]];

console.log(`Wireframes: ${url}`);
spawn(opener[0], opener[1], { stdio: 'ignore', detached: true })
  .on('error', () => console.log('Could not launch a browser; open the path above manually.'))
  .unref();
