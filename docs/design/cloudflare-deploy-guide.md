# Cloudflare 배포 가이드 (MVP)

이 프로젝트는 Cloudflare에 두 개의 Worker를 따로 배포합니다.

- API Worker: 루트 `wrangler.toml`, Worker 이름 `hereisorder`, D1 바인딩 `DB`
- 웹 Worker: `frontend/wrangler.jsonc`, Worker 이름 `hereisorder-web`, OpenNext 기반 Next.js 앱

브라우저는 웹 Worker의 상대 경로 `/api/*`만 호출합니다. 웹 Worker가 빌드 시 설정된 `API_PROXY_URL`을 사용해 API Worker로 요청을 전달하므로, 브라우저 관점에서는 화면과 API가 같은 origin에 있습니다. 이 경로를 유지해야 `HttpOnly` 세션 쿠키 인증이 정상 동작합니다.

## 0. 준비 사항

- Node.js 22
- Cloudflare 계정
- D1과 두 Worker를 배포할 수 있는 API token
- 루트와 프론트엔드 의존성

```bash
npm ci
npm ci --prefix frontend
npx wrangler whoami
```

인증되지 않았다면 `npx wrangler login`을 실행합니다.

## 1. D1 준비

최초 한 번 D1을 만들고 출력된 `database_id`를 루트 `wrangler.toml`의 top-level D1 바인딩에 반영합니다. API 배포와 원격 migration은 별도 `--env` 없이 이 바인딩을 사용합니다.

```bash
npx wrangler d1 create hereisorder
```

DB 구조의 단일 적용 경로는 `migrations/`입니다. 새 DB나 기존 DB 모두 `db/schema.sql`을 직접 실행하지 않고 Wrangler migration 명령을 사용합니다.

```bash
# 로컬
npm run db:migrate

# 원격
npm run db:migrate:remote
```

## 2. 초기 관리자 생성

fresh clone에는 관리자 seed가 포함되지 않습니다. 12자 이상의 비밀번호를 환경변수로 전달하면 PBKDF2 해시가 담긴 `data/seed_admin.sql`을 로컬에서 생성한 뒤 D1에 적용합니다. 생성 파일은 Git에 포함하지 않습니다.

```bash
# 로컬 DB: migration + 관리자 생성
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap

# 원격 DB: migration + 관리자 생성
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:remote
```

아이디와 표시 이름의 기본값은 각각 `admin`, `관리자`입니다. 필요하면 `ADMIN_USERNAME`, `ADMIN_NAME`도 함께 지정합니다.

Notion export로 카테고리/품목까지 적재하려면 저장소 루트에 `notion-export/` 입력을 준비한 뒤 다음 명령을 사용합니다.

```bash
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:from-notion
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:remote:from-notion
```

## 3. 수동 배포

API를 먼저 배포합니다.

```bash
npm run deploy
```

그다음 API Worker의 공개 origin을 `API_PROXY_URL`로 주입해 웹 Worker를 빌드·배포합니다. Production 값은 credential, path, query string, hash가 없는 HTTPS origin이어야 합니다. 로컬 개발의 `http://127.0.0.1:8787` 프록시는 허용합니다.

```bash
API_PROXY_URL='https://hereisorder.<subdomain>.workers.dev' npm run deploy --prefix frontend
```

OpenNext 산출물만 검증하거나 로컬 preview를 실행할 때는 다음 명령을 사용합니다.

```bash
API_PROXY_URL='https://hereisorder.<subdomain>.workers.dev' npm run build:cloudflare --prefix frontend
API_PROXY_URL='https://hereisorder.<subdomain>.workers.dev' npm run preview --prefix frontend
```

기존의 `wrangler pages deploy .vercel/output/static` 방식은 사용하지 않습니다. 현재 Next.js 앱은 `@opennextjs/cloudflare`가 생성하는 `.open-next/worker.js`와 `.open-next/assets`를 Cloudflare Worker로 배포합니다.

## 4. GitHub Actions 배포

`.github/workflows/deploy-worker.yml`은 pull request와 `main` push에서 다음 품질 게이트를 실행합니다.

1. 루트 `npm ci`, API typecheck/test, Worker dry-run build
2. 로컬 D1 migration 적용 검증
3. 프론트엔드 `npm ci`, lint, Next.js build
4. OpenNext Cloudflare build

검증이 성공한 `main` push 또는 수동 실행만 아래 순서로 production에 반영됩니다.

1. 원격 D1 migration 적용
2. API Worker 배포
3. 웹 Worker 배포

GitHub의 `production` environment에 다음 값을 설정합니다. `PRODUCTION_API_PROXY_URL`은 repository variable로 두어도 같은 `vars` context로 사용할 수 있습니다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | D1/Workers 배포 권한을 가진 token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| Variable | `PRODUCTION_API_PROXY_URL` | 배포된 API Worker의 HTTPS origin(credential/path/query/hash 없음) |

`PRODUCTION_API_PROXY_URL`은 웹 배포 job에서 서버 전용 `API_PROXY_URL`로 전달됩니다. 브라우저 코드에 API origin을 직접 넣지 않습니다.

## 5. 배포 후 확인

- API Worker의 `/health`가 `ok: true`를 반환하는지 확인
- 웹 Worker에서 로그인 후 새로고침해도 세션이 유지되는지 확인
- `/api/dashboard`, 품목 수정, 발주 생성과 부분입고를 smoke test
- 휴대폰 브라우저에서 레이아웃과 로그인 쿠키 동작 확인
- 관리자 계정으로 계정 관리와 감사로그 접근, staff 계정의 관리자 API `403` 확인
