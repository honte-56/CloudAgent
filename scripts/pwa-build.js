import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep the worker URL stable, but change its bytes with every client build so
// the browser installs the matching shell and assets as one version.
export function pwaBuild() {
  let config;
  return {
    name: 'cloudagent-pwa-build',
    apply: 'build',
    configResolved(resolved) { config = resolved; },
    writeBundle(_options, bundle) {
      const template = readFileSync(resolve(config.publicDir, 'sw.js'), 'utf8');
      const html = readFileSync(resolve(config.root, config.build.outDir, 'index.html'), 'utf8');
      const assets = Object.keys(bundle).filter(name => name.startsWith('assets/')).sort();
      const entries = Object.values(bundle)
        .filter(item => item.type === 'chunk' && item.isEntry)
        .map(item => `/${item.fileName}`);
      const id = createHash('sha256').update(template).update(html)
        .update(JSON.stringify(assets)).digest('hex').slice(0, 16);
      const build = { id, assets: assets.map(name => `/${name}`), entries };
      writeFileSync(resolve(config.root, config.build.outDir, 'sw.js'),
        template.replace('const BUILD = null;', `const BUILD = ${JSON.stringify(build)};`));
    },
  };
}
