# Cloudflare 배포 가이드 (MVP)

기준: Cloudflare skill(`cloudflare-deploy`) 권장 절차 준수

## 0) 인증 확인
```bash
npx wrangler whoami
```

미인증 시 `wrangler login`

## 1) D1 준비
```bash
npx wrangler d1 create hereisorder
```
출력의 `database_id`를 `wrangler.toml`에 반영.

## 2) 개발용 DB 마이그레이션
```bash
npx wrangler d1 execute hereisorder --local true --file=db/schema.sql
npx wrangler d1 execute hereisorder --local true --file=data/seed_categories_items.sql
```

원격 반영(`--remote true`)은 로컬 테스트 후.

## 3) 스키마/앱 배포
- 초기 단계에서는 Worker 중심 API + 정적 UI 1차 구현 기준으로 배포
- `wrangler.toml`에 `d1_databases` 바인딩 설정
- deploy:

```bash
npx wrangler deploy
```

(페이지 기반 배포로 전환할 경우):
```bash
npm run build && wrangler pages deploy .vercel/output/static
```

## 4) 현재 결정 반영 포인트
- 단일 관리자: 인증은 최소 세션 기반
- 단위는 `개` 고정
- 외부앱 발주 연동 없음(앱은 수량/상태/입고만 관리)
- 소프트딜리트 + 감사로그는 필수
