# GitHub Push 기반 Cloudflare 자동 배포 설계

## 배경

기존 GitHub Actions는 `main` push에서 API Worker만 배포했고 Node.js 20으로 인해 Wrangler 4 실행이 실패했다. 새 프론트엔드는 OpenNext 기반 Cloudflare Worker로 배포해야 하며, 웹 빌드가 API Worker의 production origin을 알아야 한다. 운영자가 별도 URL 변수를 입력하거나 승인 버튼을 누르지 않고 `main`에 push하는 것만으로 전체 배포가 완료되어야 한다.

## 목표

- `main`의 모든 push에서 검증 후 production을 자동 배포한다.
- production D1 migration, API Worker, 웹 Worker를 안전한 순서로 직렬 배포한다.
- API 배포 URL을 같은 workflow 안에서 웹 빌드로 전달한다.
- `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID` 외에 수동 production 변수를 요구하지 않는다.
- 배포 직후 API와 웹/API proxy를 smoke test한다.

## 비목표

- preview 또는 staging 환경 추가
- custom domain 설정
- 자동 DB rollback
- Cloudflare Dashboard의 별도 Git 연동

## 트리거와 동시성

- pull request에서는 전체 검증만 수행한다.
- `main`의 모든 push는 경로 필터 없이 검증과 production 배포를 수행한다.
- `workflow_dispatch`는 장애 시 같은 workflow를 다시 실행하는 보조 경로로 유지한다.
- production concurrency group을 하나로 고정하고 `cancel-in-progress: false`를 사용해 migration과 배포가 겹치지 않게 한다.
- GitHub Environment 승인 단계는 사용하지 않는다.

## 파이프라인

### 1. Verify

Node.js 22에서 다음을 실행한다.

1. 루트와 `frontend/` lockfile 기반 `npm ci`
2. API strict typecheck
3. seed 단위 테스트와 Workers/D1 통합 테스트
4. API Worker dry-run
5. 빈 로컬 D1에 전체 migration 적용
6. 프론트엔드 lint와 Next.js build
7. OpenNext Cloudflare build

검증 job이 실패하면 production job은 실행하지 않는다.

### 2. Deploy API

1. production D1에 미적용 migration을 적용한다.
2. Cloudflare 공식 `cloudflare/wrangler-action`으로 `hereisorder` API Worker를 배포한다.
3. action의 `deployment-url` 출력을 job output으로 공개한다.
4. 배포 URL의 HTTPS origin 형식을 검증한다.
5. `GET /health`가 200과 정상 JSON을 반환하는지 확인한다.

Migration 적용 후 API 배포가 실패할 수 있으므로 모든 migration은 직전 API와도 호환되는 확장형 변경이어야 한다. 현재 `002_integrity_and_roles.sql`은 기존 컬럼을 제거하지 않고 역할, 인덱스, 제약과 trigger를 추가한다.

### 3. Deploy Web

1. API job의 배포 URL을 서버 전용 `API_PROXY_URL`로 주입한다.
2. URL이 credential, path, query, hash가 없는 HTTPS origin인지 검증한다.
3. OpenNext bundle을 production API URL로 빌드한다.
4. Cloudflare 공식 `cloudflare/wrangler-action`으로 `hereisorder-web` Worker를 배포한다.
5. 웹 배포 URL의 `/login`이 200인지 확인한다.
6. 웹 배포 URL의 `/api/users/me`가 인증 없는 요청에 401을 반환하는지 확인해 same-origin API proxy도 검증한다.

## 시크릿과 권한

- GitHub Actions repository secret `CLOUDFLARE_API_TOKEN`
- GitHub Actions repository secret `CLOUDFLARE_ACCOUNT_ID`
- workflow 권한은 `contents: read`만 사용한다.
- Cloudflare token은 Workers Script 배포와 D1 migration에 필요한 최소 권한을 가진다.
- API URL은 공개 origin이므로 secret으로 저장하지 않고 job output으로만 전달한다.

## 실패 처리

- Verify 실패: production 변경 없음
- D1 migration 실패: API와 웹 배포 중단
- API 배포 또는 health check 실패: 웹 배포 중단
- 웹 build/deploy/smoke test 실패: workflow 실패로 표시하고 Cloudflare의 이전 배포 버전을 rollback 후보로 유지
- 자동 rollback은 migration과 코드 버전의 결합을 잘못 되돌릴 위험이 있어 수행하지 않는다.
- 각 배포 URL과 결과를 GitHub Actions job summary에 남긴다.

## 성공 기준

- 별도 입력이나 수동 승인 없이 `git push origin main`만으로 workflow가 시작된다.
- 검증, D1 migration, API 배포, API health, 웹 배포, 웹/API proxy smoke test가 순서대로 성공한다.
- 최종 GitHub Actions run이 성공으로 종료되고 API와 웹의 production URL이 기록된다.
- 이후 `main` push도 동일한 경로로 반복 배포된다.
