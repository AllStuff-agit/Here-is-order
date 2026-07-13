#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNotionImportArtifacts } from './notion-import-core.mjs';

export function writeNotionArtifacts({
  outDir,
  artifacts,
  fsImpl = fs,
  token = randomUUID(),
}) {
  fsImpl.mkdirSync(outDir, { recursive: true });
  const targets = {
    sql: path.join(outDir, 'seed_categories_items.sql'),
    csv: path.join(outDir, 'seed_items.csv'),
    report: path.join(outDir, 'import-report.json'),
  };
  const temporary = Object.fromEntries(
    Object.entries(targets).map(([key, target]) => [key, `${target}.${token}.tmp`]),
  );
  try {
    fsImpl.writeFileSync(temporary.sql, artifacts.sql, { flag: 'wx' });
    fsImpl.writeFileSync(temporary.csv, artifacts.csv, { flag: 'wx' });
    fsImpl.writeFileSync(temporary.report, JSON.stringify(artifacts.report, null, 2), { flag: 'wx' });
    if (fsImpl.existsSync(targets.report)) fsImpl.unlinkSync(targets.report);
    fsImpl.renameSync(temporary.sql, targets.sql);
    fsImpl.renameSync(temporary.csv, targets.csv);
    fsImpl.renameSync(temporary.report, targets.report);
  } catch (error) {
    for (const temporaryPath of Object.values(temporary)) {
      try { fsImpl.unlinkSync(temporaryPath); } catch {}
    }
    throw error;
  }
}

export function generateNotionImport({
  sourceDir = 'notion-export',
  outDir = 'data',
  generatedAt = new Date().toISOString(),
  log = console.log,
} = {}) {
  if (!fs.existsSync(sourceDir)) throw new Error(`notion export folder not found: ${sourceDir}`);
  const names = fs.readdirSync(sourceDir).filter((file) => file.endsWith('.md'));
  const files = names.map((file) => ({
    file,
    content: fs.readFileSync(path.join(sourceDir, file), 'utf8'),
  }));
  const artifacts = buildNotionImportArtifacts({ files, sourceDir, generatedAt });
  writeNotionArtifacts({ outDir, artifacts });

  log(`Notion seed artifacts generated: items=${artifacts.report.totalItems}, categories=${artifacts.report.totalCategories}, sha256=${artifacts.report.seedSha256}`);
  return artifacts.report;
}

function runCli() {
  try {
    generateNotionImport({ sourceDir: process.argv[2] ?? 'notion-export' });
  } catch {
    console.error('Notion import failed');
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runCli();
