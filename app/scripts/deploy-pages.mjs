// Copy the built app (app/dist) to the repo root so GitHub Pages
// ("deploy from a branch", / root) serves it. Run via: npm run deploy:pages
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(appDir, 'dist');
const root = path.dirname(appDir);

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('No dist/index.html — run the build first.');
  process.exit(1);
}

rmSync(path.join(root, 'app-assets'), { recursive: true, force: true });
rmSync(path.join(root, 'index.html'), { force: true });
rmSync(path.join(root, 'favicon.svg'), { force: true });

cpSync(path.join(dist, 'app-assets'), path.join(root, 'app-assets'), { recursive: true });
cpSync(path.join(dist, 'index.html'), path.join(root, 'index.html'));
cpSync(path.join(dist, 'favicon.svg'), path.join(root, 'favicon.svg'));

console.log('Published dist → repo root (index.html, favicon.svg, app-assets/). Commit and push to deploy.');
