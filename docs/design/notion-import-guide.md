# Notion export → 앱 seed 임포트 가이드

Notion import는 선택 기능입니다. `notion-export/`와 변환 결과인 `data/`는 계속 Git 추적 대상이 아니므로, fresh clone에서 품목 seed가 필요하면 먼저 export 입력을 직접 준비해야 합니다. 생성물에는 운영 데이터가 포함될 수 있으므로 커밋하지 않습니다. 관리자 계정만 필요한 경우에는 이 절차 없이 `ADMIN_PASSWORD=... npm run db:bootstrap`을 사용합니다.

## 파싱 규칙

- 항목명: 파일의 첫 줄 `# 품목명`
- 분류: `분류: xxx`
- 초기값: `safety_stock=0`, `min_stock=0`, `current_stock=0`, `unit='개'`, `unit_price=0`
- 중복 품목명: 첫 항목은 빈 spec, 이후 항목은 `변형-<분류>` spec으로 구분
- `is_deleted`: `0`

## 변환

루트 의존성을 설치한 뒤 export 디렉터리를 변환합니다.

```bash
npm ci
npm run import:notion
```

직접 경로를 지정하려면 다음 명령을 사용합니다.

```bash
node scripts/import-notion-export.mjs [notion-dir]
```

기본 입력은 `notion-export/`이며 다음 파일이 생성됩니다.

- `data/seed_categories_items.sql`
- `data/seed_items.csv`
- `data/import-report.json`

SQL, CSV, report의 내용과 report에 기록된 `seedSha256`을 검토합니다. 운영 D1에는 이 검토를 완료한 뒤에만 적용할 수 있습니다.

## 로컬 D1 반영

DB 구조는 `migrations/`만으로 적용하며 `db/schema.sql`을 직접 실행하지 않습니다. 로컬 D1에는 안전한 변환, migration, 품목 seed, 관리자 seed를 다음 결합 명령으로 적용합니다.

```bash
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:from-notion
```

이 로컬 결합 bootstrap은 계속 제공되며 변환이 성공한 뒤에만 나머지 단계를 실행합니다.

## 원격 D1 반영

생성부터 원격 적용까지 한 번에 실행하던 Notion 결합 bootstrap 기능은 제거했습니다. 운영에서는 생성물 검토가 적용보다 반드시 먼저이며 다음 순서만 사용합니다.

```bash
npm run import:notion
# data/seed_categories_items.sql, data/seed_items.csv,
# data/import-report.json과 seedSha256을 검토합니다.
npm run db:migrate:remote
npm run db:seed:remote -- --expected-sha <검토한-64자리-SHA-256>
# 최초 bootstrap에서만 실행합니다.
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:seed:admin:remote
```

`db:seed:remote`는 검토자가 전달한 SHA-256, `import-report.json`의 `seedSha256`, 실제 `seed_categories_items.sql`의 SHA-256이 모두 일치할 때만 Wrangler를 호출합니다. 운영 품목 seed SQL을 Wrangler로 직접 적용하지 않습니다.

관리자 seed는 최초 bootstrap에서만 실행합니다. 생성 시 `ADMIN_USERNAME`과 `ADMIN_NAME`을 생략하면 각각 `admin`, `관리자`가 사용됩니다. `data/seed_admin.sql`은 명령 실행 때마다 로컬에서 생성되며 다른 `data/` 생성물과 마찬가지로 Git에 포함하지 않습니다.
