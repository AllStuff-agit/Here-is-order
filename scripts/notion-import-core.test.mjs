import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildItemSeedSql,
  buildNotionImportArtifacts,
  compareCodePoints,
  parseNotionRecords,
} from './notion-import-core.mjs';

const GENERATED_AT = '2026-07-13T00:00:00.000Z';
const files = [
  {
    file: '02-injection.md',
    content: '# x"); DROP TABLE users; --\n분류: 분류\'); DROP TABLE item_categories; --',
  },
  {
    file: '01-quote.md',
    content: "# O'Brien\n분류: 원두\n-- comment",
  },
  {
    file: '03-formula.md',
    content: '# =HYPERLINK("https://evil.invalid")\n',
  },
];

test('악성 text를 SQL data로 보존하고 CSV formula를 중화한다', () => {
  const artifacts = buildNotionImportArtifacts({
    files,
    sourceDir: 'fixture',
    generatedAt: GENERATED_AT,
  });

  assert.match(artifacts.sql, /'x"\); DROP TABLE users; --'/);
  assert.match(artifacts.sql, /'분류''\); DROP TABLE item_categories; --'/);
  assert.match(artifacts.sql, /'O''Brien'/);
  assert.match(artifacts.sql, /VALUES \(NULL, '=HYPERLINK/);
  assert.match(artifacts.csv, /"'=HYPERLINK\(""https:\/\/evil\.invalid""\)"/);
  assert.equal(
    artifacts.report.seedSha256,
    createHash('sha256').update(artifacts.sql, 'utf8').digest('hex'),
  );
});

test('선행 whitespace 뒤의 모든 CSV formula marker를 SQL 변경 없이 중화한다', () => {
  const formulaFiles = ['=', '+', '-', '@'].map((marker, index) => ({
    file: ` ${marker}formula-${index}.md`,
    content: 'title 없는 본문',
  }));
  const artifacts = buildNotionImportArtifacts({
    files: formulaFiles,
    sourceDir: 'fixture',
    generatedAt: GENERATED_AT,
  });

  for (const [index, marker] of ['=', '+', '-', '@'].entries()) {
    assert.ok(artifacts.csv.includes(`"' ${marker}formula-${index}.md"`));
    assert.ok(artifacts.csv.includes(`"' ${marker}formula-${index}"`));
    assert.ok(artifacts.sql.includes(`VALUES (NULL, ' ${marker}formula-${index}',`));
    assert.ok(!artifacts.sql.includes(`VALUES (NULL, ''' ${marker}formula-${index}',`));
  }
});

test('입력 순서와 ICU locale에 관계없이 artifact를 결정론적으로 만든다', () => {
  const forward = buildNotionImportArtifacts({
    files,
    sourceDir: 'fixture',
    generatedAt: GENERATED_AT,
  });
  const reverse = buildNotionImportArtifacts({
    files: [...files].reverse(),
    sourceDir: 'fixture',
    generatedAt: GENERATED_AT,
  });
  assert.equal(reverse.sql, forward.sql);
  assert.equal(reverse.csv, forward.csv);
  assert.deepEqual(reverse.report, forward.report);
  assert.deepEqual(
    ['😀.md', '가.md', 'a.md', 'A.md'].sort(compareCodePoints),
    ['A.md', 'a.md', '가.md', '😀.md'],
  );
});

test('빈 export, NUL, 최종 identity 충돌을 쓰기 전에 거부한다', () => {
  assert.throws(
    () => buildNotionImportArtifacts({ files: [], sourceDir: 'empty', generatedAt: GENERATED_AT }),
    /Markdown 파일이 없습니다/,
  );
  assert.throws(
    () => buildNotionImportArtifacts({
      files: [{ file: 'nul.md', content: '# bad\0name' }],
      sourceDir: 'fixture',
      generatedAt: GENERATED_AT,
    }),
    /nul\.md.*name.*NUL/,
  );
  assert.throws(
    () => buildNotionImportArtifacts({
      files: [
        { file: 'a.md', content: '# same\n분류: beans' },
        { file: 'b.md', content: '# same\n분류: beans' },
        { file: 'c.md', content: '# same\n분류: beans' },
      ],
      sourceDir: 'fixture',
      generatedAt: GENERATED_AT,
    }),
    /same::변형-beans.*b\.md.*c\.md/,
  );
});

test('구분자 직렬화가 같은 서로 다른 name과 spec tuple을 충돌로 보지 않는다', () => {
  const tupleFiles = [
    { file: '01-base.md', content: '# a\n분류: base' },
    { file: '02-duplicate.md', content: '# a\n분류: b::' },
    { file: '03-delimited-name.md', content: '# a::변형-b' },
  ];

  assert.deepEqual(
    parseNotionRecords(tupleFiles).map(({ name, spec }) => [name, spec]),
    [
      ['a', ''],
      ['a', '변형-b::'],
      ['a::변형-b', ''],
    ],
  );
  assert.equal(
    buildNotionImportArtifacts({
      files: tupleFiles,
      sourceDir: 'fixture',
      generatedAt: GENERATED_AT,
    }).report.totalItems,
    3,
  );
});

test('filename의 NUL을 거부한다', () => {
  assert.throws(
    () => buildNotionImportArtifacts({
      files: [{ file: 'bad\0file.md', content: '# safe' }],
      sourceDir: 'fixture',
      generatedAt: GENERATED_AT,
    }),
    /file.*NUL/,
  );
});

test('파싱에서 무시되는 Markdown text의 NUL도 거부한다', () => {
  assert.throws(
    () => buildNotionImportArtifacts({
      files: [{ file: 'ignored.md', content: '# safe\nignored\0text' }],
      sourceDir: 'fixture',
      generatedAt: GENERATED_AT,
    }),
    /ignored\.md.*content.*NUL/,
  );
});

test('public item SQL builder도 모든 숫자 field를 검증한다', () => {
  const item = {
    file: 'numeric.md', name: 'numeric', category: '', spec: '', recommended_unit: '개',
    safety_stock: 0, min_stock: 0, current_stock: 0, unit_price: 0, memo: '',
  };
  for (const field of ['safety_stock', 'min_stock', 'current_stock', 'unit_price']) {
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => buildItemSeedSql([{ ...item, [field]: invalid }]),
        new RegExp(`${field}는 0 이상의 안전한 정수`),
      );
    }
  }
});
