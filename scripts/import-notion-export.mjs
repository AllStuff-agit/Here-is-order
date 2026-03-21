#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const sourceDir = process.argv[2] ?? 'notion-export';
const outDir = 'data';

if (!fs.existsSync(sourceDir)) {
  console.error(`notion export folder not found: ${sourceDir}`);
  process.exit(1);
}

const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md')).sort((a, b) => a.localeCompare(b, 'ko'));

const categorySet = new Set();
const byName = new Map();

const items = [];

for (const file of files) {
  const full = path.join(sourceDir, file);
  const raw = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
  const titleLine = raw.find((l) => l.trim().startsWith('# ')) || '';
  const name = titleLine.replace(/^#\s*/, '').trim() || path.parse(file).name.replace(/\s+317830bfc2f[0-9a-f]+$/i, '');
  const catLine = raw.find((l) => l.startsWith('분류:'));
  const category = catLine ? catLine.replace('분류:', '').trim() : '';
  const itemKey = `${name}::${category}`;

  if (!categorySet.has(category) && category) categorySet.add(category);

  const seen = byName.get(name) || 0;
  byName.set(name, seen + 1);

  // spec은 중복 이름일 때만 카테고리를 붙여 variant를 명확히 함
  const spec = seen > 0 ? `변형-${category || '기본'}` : '';

  items.push({
    file,
    name,
    category,
    spec,
    safety_stock: 0,
    min_stock: 0,
    current_stock: 0,
    unit_price: 0,
    memo: '',
    recommended_unit: '개',
  });
}

fs.mkdirSync(outDir, { recursive: true });

// categories
const categories = [...categorySet].sort((a, b) => a.localeCompare(b, 'ko')).map((name) => `INSERT OR IGNORE INTO item_categories (name) VALUES (${JSON.stringify(name)});`);

const itemSql = items.map((it) => {
  const cols = ['category_id', 'name', 'spec', 'unit', 'safety_stock', 'min_stock', 'current_stock', 'unit_price', 'memo'];
  const values = [
    `(SELECT id FROM item_categories WHERE name = ${JSON.stringify(it.category)} LIMIT 1)`,
    JSON.stringify(it.name),
    JSON.stringify(it.spec),
    JSON.stringify(it.recommended_unit),
    it.safety_stock,
    it.min_stock,
    it.current_stock,
    it.unit_price,
    JSON.stringify(it.memo),
  ];
  return `INSERT OR IGNORE INTO items (category_id, name, spec, unit, safety_stock, min_stock, current_stock, unit_price, memo)
    VALUES (${values.join(', ')});`;
});

const csvHeader = 'file,name,category,spec,safety_stock,min_stock,current_stock,unit_price,memo\n';
const csvRows = items.map((it) => [it.file, it.name, it.category, it.spec, it.safety_stock, it.min_stock, it.current_stock, it.unit_price, it.memo].map((x) => `"${String(x ?? '').replaceAll('"', '""')}"`).join(','));

const sql = [
  '-- Seed categories',
  ...categories,
  '',
  '-- Seed items',
  ...itemSql,
].join('\n');

fs.writeFileSync(path.join(outDir, 'seed_categories_items.sql'), sql);
fs.writeFileSync(path.join(outDir, 'seed_items.csv'), csvHeader + csvRows.join('\n'));

const duplicates = [...byName.entries()].filter(([, count]) => count > 1);

const report = {
  sourceDir,
  totalFiles: files.length,
  totalItems: items.length,
  totalCategories: categorySet.size,
  duplicateItemNames: duplicates.length,
  duplicateSample: duplicates.slice(0, 20),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outDir, 'import-report.json'), JSON.stringify(report, null, 2));

console.log('Generated:');
console.log('- data/seed_categories_items.sql');
console.log('- data/seed_items.csv');
console.log('- data/import-report.json');
console.log(`items=${items.length}, categories=${categorySet.size}, duplicateNames=${duplicates.length}`);
