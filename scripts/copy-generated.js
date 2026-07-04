/**
 * Copies generated CDK stacks and Lambda handlers from anahata-billing-model
 * into src/generated/ for this repository's build.
 *
 * Source: ../anahata-billing-model/src/generated/
 * Destination: ./src/generated/
 *
 * This runs as part of `npm run build` before TypeScript compilation.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Try local file reference first, then node_modules
const localModelPath = resolve(projectRoot, '../anahata-billing-model/src/generated');
const nodeModulesPath = resolve(projectRoot, 'node_modules/@anahata/billing-model/src/generated');

let sourcePath;
if (existsSync(localModelPath)) {
  sourcePath = localModelPath;
  console.log(`Using local anahata-billing-model: ${localModelPath}`);
} else if (existsSync(nodeModulesPath)) {
  sourcePath = nodeModulesPath;
  console.log(`Using node_modules @anahata/billing-model: ${nodeModulesPath}`);
} else {
  console.warn('⚠ No generated source found. Skipping copy-generated.');
  console.warn('  Expected at:', localModelPath);
  console.warn('  Or at:', nodeModulesPath);
  process.exit(0);
}

const destPath = resolve(projectRoot, 'src/generated');

// Clean destination
if (existsSync(destPath)) {
  rmSync(destPath, { recursive: true, force: true });
}
mkdirSync(destPath, { recursive: true });

// Copy generated CDK stacks
const cdkSource = resolve(sourcePath, 'cdk');
if (existsSync(cdkSource)) {
  cpSync(cdkSource, resolve(destPath, 'cdk'), { recursive: true });
  console.log('✓ Copied generated CDK stacks');
} else {
  console.warn('⚠ No generated CDK stacks found at:', cdkSource);
}

// Copy generated Lambda handlers
const lambdaSource = resolve(sourcePath, 'lambda');
if (existsSync(lambdaSource)) {
  cpSync(lambdaSource, resolve(destPath, 'lambda'), { recursive: true });
  console.log('✓ Copied generated Lambda handlers');
} else {
  console.warn('⚠ No generated Lambda handlers found at:', lambdaSource);
}

// ── Patch generated CDK stacks ──
// For tables that already exist (Phase 1 tables that were created on first deploy
// with RETAIN policy), replace "new dynamodb.Table(...)" with "Table.fromTableName(...)".
// For NEW tables (Phase 2/3), leave the creation code intact so CDK creates them.
import { readdirSync, readFileSync, writeFileSync } from 'fs';

// Tables that are KNOWN to already exist in the AWS account (created in earlier deploys).
// Only these get patched to import mode. New tables will be created normally by CDK.
const EXISTING_TABLES = [
  'BillingOrganizations',
  'BillingUsers',
  'BillingAccessRoles',
  'BillingInvitations',
  'AnahataBillingProducts',
  'AnahataBillingPricingPlans',
  'AnahataBillingCustomers',
  'AnahataBillingSubscriptions',
];

const cdkDest = resolve(destPath, 'cdk');
if (existsSync(cdkDest)) {
  const cdkFiles = readdirSync(cdkDest).filter(f => f.endsWith('.ts'));
  for (const file of cdkFiles) {
    const filePath = resolve(cdkDest, file);
    let content = readFileSync(filePath, 'utf-8');

    // Pattern: new dynamodb.Table(this, "ID", { tableName: "X", ... })
    const tableRegex = /const table = new dynamodb\.Table\(this,\s*"([^"]+)",\s*\{[\s\S]*?tableName:\s*"([^"]+)"[\s\S]*?removalPolicy:\s*RemovalPolicy\.RETAIN\s*\}\);/g;
    
    let patched = false;
    content = content.replace(tableRegex, (match, constructId, tableName) => {
      if (EXISTING_TABLES.includes(tableName)) {
        patched = true;
        return `// Table already exists (created on first deploy with RETAIN policy)
    const table = dynamodb.Table.fromTableName(this, "${constructId}", "${tableName}");`;
      }
      // Table doesn't exist yet — leave creation code intact
      return match;
    });

    if (patched) {
      // Remove GSI additions for imported tables (can't add GSI to imported table)
      content = content.replace(/\s*table\.addGlobalSecondaryIndex\(\{[\s\S]*?\}\);\s*/g, '\n');
      writeFileSync(filePath, content, 'utf-8');
      console.log(`  ✓ Patched ${file} (table import mode)`);
    }
  }
  console.log('✓ Patched generated stacks for existing tables');
}

// ── Patch generated Lambda handlers ──
// Fix import path: the Smithy plugin generates `@anahata/service-model` but
// in the billing project the package is `@anahata/billing-model`.
const lambdaDest = resolve(destPath, 'lambda');
if (existsSync(lambdaDest)) {
  const lambdaFiles = readdirSync(lambdaDest).filter(f => f.endsWith('.ts'));
  for (const file of lambdaFiles) {
    const filePath = resolve(lambdaDest, file);
    let content = readFileSync(filePath, 'utf-8');
    let patched = false;

    if (content.includes('@anahata/service-model')) {
      content = content.replace(/@anahata\/service-model/g, '@anahata/billing-model');
      patched = true;
    }

    // Patch ApiKey handler: auto-generate keyValue on create
    if (file === 'AikoraApiKeyHandler.ts') {
      content = content.replace(
        'item.createdAt = new Date().toISOString();',
        `// Auto-generate a secure API key value (bk_ prefix + random UUID)
  item.keyValue = 'bk_' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16);
  item.status = item.status || 'ACTIVE';
  item.createdAt = new Date().toISOString();`
      );
      patched = true;
      console.log(`  ✓ Patched ${file} (keyValue generation)`);
    }

    if (patched) {
      writeFileSync(filePath, content, 'utf-8');
      if (!file.includes('ApiKey')) console.log(`  ✓ Patched ${file} (import path)`);
    }
  }
  console.log('✓ Patched generated Lambda imports');
}

console.log('✓ copy-generated complete');
