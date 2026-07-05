# Repository Guidelines

## 프로젝트 구조 및 모듈 구성
- `src/index.ts`: Cloudflare Worker API와 Hono 라우팅을 관리합니다.
- `frontend/`: Next.js 프론트엔드 앱입니다. `app/`은 라우트, `components/`는 공통 UI, `hooks/`는 React 훅, `lib/`는 API 클라이언트와 유틸리티를 담습니다.
- `db/`와 `migrations/`: D1 스키마와 마이그레이션 파일을 관리합니다.
- `data/`: seed SQL, CSV, import report 등 생성 데이터를 보관합니다.
- `scripts/`: Notion export 변환 등 유지보수 스크립트가 있습니다.
- `docs/`: API 명세, 배포 가이드, 설계 문서를 확인하는 기본 위치입니다.
- `notion-export/`: 초기 seed 생성을 위한 Notion export 입력입니다.

## 빌드, 테스트, 개발 명령어
- `npm ci`: 루트 의존성을 설치합니다.
- `npm run dev:api`: Worker API를 로컬에서 실행합니다.
- `npm run web:dev`: 프론트엔드 개발 서버를 실행합니다.
- `npm run web:dev:local`: `/api/*` 요청을 `http://127.0.0.1:8787`로 프록시합니다.
- `npm run web:lint`: 프론트엔드 ESLint 검사를 실행합니다.
- `npm run web:build`: 프론트엔드 프로덕션 빌드를 확인합니다.
- `npm run build`: Worker 배포 dry-run을 실행합니다.
- `npm run db:bootstrap:from-notion`: Notion export 기반으로 로컬 D1 데이터를 초기화합니다.

## 코딩 스타일 및 네이밍 규칙
TypeScript와 React/Next.js 관례를 따릅니다. 기존 코드처럼 2칸 들여쓰기, 작은따옴표, 세미콜론을 사용합니다. 컴포넌트는 `PascalCase`, 함수와 변수는 `camelCase`, 상수는 `UPPER_SNAKE_CASE`를 사용합니다. 라우트와 일반 파일명은 가능한 `kebab-case`로 작성합니다.

## 테스트 가이드라인
현재 별도 테스트 프레임워크는 구성되어 있지 않습니다. 변경 후 최소 검증으로 `npm run web:lint`, `npm run web:build`, `npm run build`를 실행합니다. API 변경은 `npm run dev:api`로 서버를 띄운 뒤 관련 `/api/*` 엔드포인트를 smoke test 합니다. DB 변경은 migration 적용과 seed 재생성을 함께 확인합니다.

## 커밋 및 Pull Request 가이드라인
Git 기록은 `feat:`, `fix:`, `design:`, `refactor:` 형식을 주로 사용합니다. 커밋 메시지는 변경 목적을 짧고 명확하게 작성합니다. PR에는 변경 요약, 검증 결과, 관련 이슈, DB/migration 변경 여부를 포함합니다. UI 변경은 스크린샷이나 짧은 영상을 첨부합니다.

## 보안 및 설정 주의사항
`.env`, `.dev.vars`, Cloudflare 토큰 등 민감 정보는 커밋하지 않습니다. `wrangler.toml`, D1 binding, migration 변경은 배포 영향이 있으므로 PR에서 명확히 설명합니다. `.wrangler/`, `.next/`, `node_modules/` 같은 생성물은 소스 변경과 분리합니다.
