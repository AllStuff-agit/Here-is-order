import { createHash } from 'node:crypto';
import path from 'node:path';

import { sqlText } from './sqlite-sql.mjs';

export function compareCodePoints(left, right) {
  const a = Array.from(String(left));
  const b = Array.from(String(right));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function checkedText(value, file, field) {
  const text = String(value);
  if (text.includes('\0')) {
    throw new Error(`${file}의 ${field}에는 NUL 문자를 사용할 수 없습니다.`);
  }
  return text;
}

function checkedNonNegativeInteger(value, file, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${file}의 ${field}는 0 이상의 안전한 정수여야 합니다.`);
  }
  return value;
}

function validateImportItem(item) {
  for (const field of ['name', 'category', 'spec', 'recommended_unit', 'memo']) {
    checkedText(item[field], item.file, field);
  }
  for (const field of ['safety_stock', 'min_stock', 'current_stock', 'unit_price']) {
    checkedNonNegativeInteger(item[field], item.file, field);
  }
}

export function parseNotionRecords(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Notion export에 Markdown 파일이 없습니다.');
  }

  const seenByName = new Map();
  const items = [...files]
    .sort((left, right) => compareCodePoints(left.file, right.file))
    .map(({ file, content }) => {
      const lines = String(content).split(/\r?\n/);
      const titleLine = lines.find((line) => line.trim().startsWith('# ')) || '';
      const fallback = path.parse(file).name.replace(/\s+317830bfc2f[0-9a-f]+$/i, '');
      const name = checkedText(titleLine.replace(/^#\s*/, '').trim() || fallback, file, 'name');
      if (!name) throw new Error(`${file}의 name은 비워둘 수 없습니다.`);
      const categoryLine = lines.find((line) => line.startsWith('분류:'));
      const category = checkedText(
        categoryLine ? categoryLine.replace('분류:', '').trim() : '',
        file,
        'category',
      );
      const seen = seenByName.get(name) ?? 0;
      seenByName.set(name, seen + 1);
      const item = {
        file,
        name,
        category,
        spec: seen > 0 ? `변형-${category || '기본'}` : '',
        safety_stock: 0,
        min_stock: 0,
        current_stock: 0,
        unit_price: 0,
        memo: '',
        recommended_unit: '개',
      };
      for (const field of ['safety_stock', 'min_stock', 'current_stock', 'unit_price']) {
        checkedNonNegativeInteger(item[field], file, field);
      }
      return item;
    });

  const identityFiles = new Map();
  for (const item of items) {
    const identity = `${item.name}::${item.spec}`;
    identityFiles.set(identity, [...(identityFiles.get(identity) ?? []), item.file]);
  }
  const collision = [...identityFiles.entries()].find(([, sourceFiles]) => sourceFiles.length > 1);
  if (collision) {
    throw new Error(`중복 item identity ${collision[0]}: ${collision[1].join(', ')}`);
  }

  return items;
}

export function buildCategorySeedSql(categories) {
  return [...categories]
    .sort(compareCodePoints)
    .map((name) => `INSERT OR IGNORE INTO item_categories (name) VALUES (${sqlText(name)});`);
}

export function buildItemSeedSql(items) {
  return items.map((item) => {
    validateImportItem(item);
    const categoryId = item.category
      ? `(SELECT id FROM item_categories WHERE name = ${sqlText(item.category)} LIMIT 1)`
      : 'NULL';
    const values = [
      categoryId,
      sqlText(item.name),
      sqlText(item.spec),
      sqlText(item.recommended_unit),
      item.safety_stock,
      item.min_stock,
      item.current_stock,
      item.unit_price,
      sqlText(item.memo),
    ];
    return `INSERT OR IGNORE INTO items (category_id, name, spec, unit, safety_stock, min_stock, current_stock, unit_price, memo)\n    VALUES (${values.join(', ')});`;
  });
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildNotionImportArtifacts({ files, sourceDir, generatedAt }) {
  const items = parseNotionRecords(files);
  const categories = new Set(items.map((item) => item.category).filter(Boolean));
  const categoriesSql = buildCategorySeedSql(categories);
  const itemsSql = buildItemSeedSql(items);
  const sql = ['-- Seed categories', ...categoriesSql, '', '-- Seed items', ...itemsSql].join('\n');
  const csvHeader = 'file,name,category,spec,safety_stock,min_stock,current_stock,unit_price,memo\n';
  const csv = csvHeader + items.map((item) => [
    item.file,
    item.name,
    item.category,
    item.spec,
    item.safety_stock,
    item.min_stock,
    item.current_stock,
    item.unit_price,
    item.memo,
  ].map(csvCell).join(',')).join('\n');
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  const report = {
    sourceDir,
    totalFiles: files.length,
    totalItems: items.length,
    totalCategories: categories.size,
    duplicateItemNames: duplicates.length,
    duplicateSample: duplicates.slice(0, 20),
    generatedAt,
    seedSha256: createHash('sha256').update(sql, 'utf8').digest('hex'),
  };
  return { sql, csv, report };
}
