# Notion export -> 앱 seed 임포트 가이드

현재 `notion-export/` 폴더의 md 파일은 항목 제목 + 분류 라인만 있으므로,
초기 시드로 바로 적재할 수 있도록 아래 규칙으로 변환합니다.

## 파싱 규칙
- 항목명: 파일의 첫 줄 `# 품목명`
- 분류: `분류: xxx`
- 초기값: `safety_stock=0`, `min_stock=0`, `current_stock=0`, `unit='개'`, `unit_price=0`
- 중복 품목명(예: 딸기/레몬/망고/자몽 등): 첫 번째는 spec 빈값, 이후 건은 `변형-<분류>`로 구분
- `is_deleted`는 초기엔 `0`

## 생성 산출물
실행:
```bash
node scripts/import-notion-export.mjs [notion-dir]
```

- 기본 입력: `notion-export`
- 기본 출력:
  - `data/seed_categories_items.sql`
  - `data/seed_items.csv`
  - `data/import-report.json`

## D1 반영 예시
```bash
# 1) D1 DB 생성 후
wrangler d1 execute <DB_NAME> --file=db/schema.sql --local=true

# 2) 시드 삽입
wrangler d1 execute <DB_NAME> --file=data/seed_categories_items.sql --local=true
```

`<DB_NAME>`는 wrangler.toml의 `database_name`과 동일해야 함.

## 현재 임포트 품목 통계
- 파일 수: 148
- 카테고리 수: 33
- 중복 품목명: 18개 (리포트에 상세)
