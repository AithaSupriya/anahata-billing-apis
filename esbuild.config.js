/**
 * esbuild configuration for Billing Service APIs.
 *
 * Bundles each Lambda handler individually for optimized cold starts.
 * Uses ESM format with createRequire banner for native module compatibility.
 */
import esbuild from 'esbuild';
import { readdirSync, existsSync, copyFileSync } from 'fs';
import { resolve, basename, extname } from 'path';

// ── Custom Lambda handlers (src/lambda/) ──
const customLambdaDir = 'src/lambda';
const customHandlers = existsSync(customLambdaDir)
  ? readdirSync(customLambdaDir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .map(f => ({
        entry: `${customLambdaDir}/${f}`,
        output: `dist/lambda/${basename(f, extname(f))}.js`,
      }))
  : [];

// ── Generated Lambda handlers (src/generated/lambda/) ──
const generatedLambdaDir = 'src/generated/lambda';
const generatedHandlers = existsSync(generatedLambdaDir)
  ? readdirSync(generatedLambdaDir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .map(f => ({
        entry: `${generatedLambdaDir}/${f}`,
        output: `dist/generated/lambda/${basename(f, extname(f))}.js`,
      }))
  : [];

const allHandlers = [...customHandlers, ...generatedHandlers];

if (allHandlers.length === 0) {
  console.log('No Lambda handlers found to bundle.');
  process.exit(0);
}

console.log(`Bundling ${allHandlers.length} Lambda handler(s)...`);

Promise.all(
  allHandlers.map(({ entry, output }) =>
    esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      outfile: output,
      external: ['@aws-sdk/*'],
      minify: false,
      sourcemap: true,
    })
  )
)
  .then(() => {
    // Copy package.json with "type": "module" to all Lambda output directories
    const pkgSrc = 'libs/package.json';
    if (existsSync(pkgSrc)) {
      if (existsSync('dist/lambda')) copyFileSync(pkgSrc, 'dist/lambda/package.json');
      if (existsSync('dist/generated/lambda')) copyFileSync(pkgSrc, 'dist/generated/lambda/package.json');
      console.log('✓ Copied package.json to Lambda directories');
    }
    console.log('✓ All Lambda handlers bundled successfully.');
  })
  .catch((err) => {
    console.error('✗ esbuild failed:', err);
    process.exit(1);
  });
