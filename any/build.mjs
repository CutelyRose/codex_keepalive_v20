import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/assets', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/assets/app.js',
  minify: true,
  legalComments: 'none',
});
await copyFile('index.html', 'dist/index.html');
await build({
  stdin: { contents: [
    "export * from './src/core/task-config';", "export * from './src/core/api-url';",
    "export { ServerTaskEngine } from './src/live/server-task-engine';", "export { AnyRouterGateway } from './src/live/anyrouter-gateway';",
    "export { NotificationReadError } from './src/live/notification-client';",
  ].join('\n'), resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/server-core.mjs',
});
console.log('Built browser console.');
