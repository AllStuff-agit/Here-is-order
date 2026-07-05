# 카페 발주 관리 웹 MVP (Cloudflare D1 + Workers)

> 단일 관리자(1명), 모바일 우선 사용, 발주 수동 연동, 재고·발주 현황 관리용 웹 서비스

## 현재 상태

현재 구현한 기능

- 단일 관리자 세션 로그인 (`/login`)
- 품목 관리: 조회/등록/수정/soft-delete
- 재고 조정: IN / OUT / ADJUST + 히스토리 기록
- 발주 관리: 발주서 생성/수정/삭제, 항목 추가/수정, 부분입고
- 대시보드: 발주 필요 품목 카운트 + 배지 알림 + 최근 기간 집계
- soft-delete + 감사로그(audit logs)
- Notion export(`notion-export/`) 기반 초기 seed 생성/적용

## 빠른 시작 (로컬)

```bash
npm ci
npm run db:bootstrap:from-notion   # notion-export -> D1 local seed + 관리자 생성
npm run dev:api
```

### 프론트엔드(리뉴얼) 실행

메인 프론트엔드는 `frontend/` 폴더의 Next.js 앱입니다.

```bash
cd frontend
npm install
npm run dev
```

기본 관리자 계정은 `seed_admin.sql` 기준:

- 아이디: `admin`
- 비밀번호: `admin1234`

### 비밀번호를 잊어버렸을 때

Cloudflare D1 콘솔에서 직접 비밀번호를 초기화할 수 있습니다.

1. [dash.cloudflare.com](https://dash.cloudflare.com)에 로그인합니다.
2. 좌측 메뉴에서 **Storage & Databases → D1 SQL Database**를 클릭합니다.
3. **hereisorder** 데이터베이스를 클릭합니다.
4. 상단 **Console** 탭을 클릭합니다.
5. 새 비밀번호의 SHA-256 해시를 구합니다. 예: [SHA-256 온라인 도구](https://emn178.github.io/online-tools/sha256.html)에 새 비밀번호를 입력하면 해시값이 나옵니다.
6. 아래 SQL을 입력하고 **Execute** 버튼을 누릅니다.

```sql
UPDATE users
SET password_hash = '여기에_SHA256_해시값_붙여넣기'
WHERE username = '아이디';
```

7. 앱으로 돌아와 새 비밀번호로 로그인합니다.

## API 체크리스트

- `POST /api/auth/login`
- `GET /api/dashboard`
- `GET /api/items?needReorder=true`
- `POST /api/stock/adjust`
- `GET /api/stock/ledger/:item_id`
- `POST /api/purchase-orders`, `PATCH /api/purchase-orders/:id`
- `POST /api/purchase-orders/:id/items`, `POST .../items/:itemId/receive`

## 프론트엔드/백엔드 실행 분리

- 백엔드(Cloudflare Worker): `npm run dev:api`
- 프론트엔드(next app, shadcn 기반): `npm run web:dev`
- 로컬 프록시 고정(권장): `npm run web:dev:local`

`web:dev:local`는 Next 개발 서버가 `/api/*` 요청을 `http://127.0.0.1:8787`로 프록시하도록 해
쿠키 기반 인증이 브라우저에서 정상 동작하도록 돕습니다.

### 프로젝트 스크립트 요약

- `dev:api`: API Worker 실행 (`wrangler dev`)
- `web:dev`: 프론트엔드 개발 서버
- `web:dev:local`: 프론트엔드 개발 서버 + API 프록시 기본 설정
- `web:build`: 프론트엔드 빌드
- `web:start`: 프론트엔드 실행
- `web:lint`: 프론트엔드 lint
- `build`: Worker 배포 전 dry-run
- `deploy`: Worker 배포

## Cloudflare 배포 (원격)

```bash
# 1) 인증
npx wrangler whoami
# 미인증이면 npx wrangler login

# 2) DB 생성 (Cloudflare dashboard/CLI)
npx wrangler d1 create hereisorder

# 3) wrangler.toml의 <DB_ID>를 생성된 database_id로 교체

# 4) DB 마이그레이션/시드(원격)
npm run db:bootstrap:remote:from-notion

# 5) 배포
npm run deploy
```

> 참고: 이 저장소는 요청하신 Cloudflare D1 기반 배포를 전제로 설계되어 있습니다.
