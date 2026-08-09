# 내 카카오톡 답장 도우미

카카오톡 내보내기 파일과 사용자가 입력한 현재 상황을 바탕으로, 관계와 맥락을 구분해 답장 후보 세 개를 만드는 개인용 MVP입니다. 단일 개인 계정의 비공개 배포만을 전제로 합니다.

## 준비 사항

- Node.js 22 이상
- `pnpm` 10.15.1(Corepack 사용 권장)
- PostgreSQL과 `pgvector`
- 구조화 출력과 1,536차원 임베딩을 지원하는 모델 제공자 설정

## 설치와 환경 설정

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
```

`.env.local`에는 다음 값을 채웁니다.

- `DATABASE_URL`: 전용 PostgreSQL 데이터베이스 URL
- `APP_ENCRYPTION_KEY`, `SESSION_SIGNING_KEY`: 각각 독립적인 32바이트 키의 canonical base64 값
- `APP_PASSWORD_HASH`: 단일 사용자 로그인 비밀번호의 Argon2id 해시
- `OPENAI_API_KEY`, `ANALYSIS_MODEL`, `REPLY_MODEL`, `EMBEDDING_MODEL`: 모델 제공자 설정

키와 비밀번호 해시 생성, PostgreSQL 역할, `vector`/`pgcrypto` 확장, HTTPS 프록시 설정은 [비공개 배포 운영 문서](docs/operations/private-deployment.md)를 따릅니다.

## 마이그레이션과 개발 서버

```sh
pnpm exec drizzle-kit migrate
pnpm dev
```

`http://localhost:3000`에서 로그인합니다. 배포 전에는 `pnpm build`와 `/api/health` 확인까지 수행합니다.

## 검증된 네 화면 흐름

1. **대화방** — `/rooms`에서 카카오톡 `.txt`를 업로드하고, 내 이름과 파싱되지 않은 줄을 검토한 뒤 분석을 시작합니다. 같은 방을 다시 가져오면 이미 저장된 메시지는 중복 저장하지 않습니다.
2. **프로필 검수** — 분석이 끝난 대화방에서 상대 프로필을 열고 근거, 확신도, 조건과 예외를 확인합니다. 직접 수정하거나 AI 교정 제안을 받은 뒤 명시적으로 확인해 반영합니다.
3. **현재 맥락 입력** — 답장 만들기 화면에서 최근 대화, 현재 상황, 답장 목적, 관계 스타일과 이번 요청의 우회 강도를 입력합니다. 기본 강도는 3이며 이번 답장에만 1~5로 바꿀 수 있습니다.
4. **답장 세 개** — 관계 유지, 감정 신호, 더 분명한 요청 전략의 후보 세 개를 확인하고 수정 또는 복사합니다. 맥락이 부족하면 한 가지 추가 질문에 답한 뒤 다시 생성합니다.

## 테스트

```sh
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit
pnpm build
pnpm test:e2e
```

Playwright가 내려받은 Chromium 대신 설치된 Chrome을 사용하려면 다음처럼 실행합니다.

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" pnpm test:e2e
```

실제 PostgreSQL 외래 키 연쇄 삭제는 이름에 독립된 `test` 표식이 있는 전용 데이터베이스에서만 검증합니다.

```sh
E2E_DATABASE_URL='postgresql://private_reply_app:password@127.0.0.1:5432/private_reply_e2e_test' pnpm test:e2e:postgres
```

## 데이터 삭제

대화방 상세 화면의 **대화방 삭제**를 누르면 원문 메시지, 턴, 청크, 장기 기억, 프로필 사실과 수정 이력, 답장 요청과 후보가 외래 키 연쇄 삭제 대상이 됩니다. 삭제 뒤 목록과 직접 URL을 확인하고, 운영 데이터베이스에서는 [운영 문서의 삭제 확인 쿼리](docs/operations/private-deployment.md#6-delete-verification)로 모든 개수가 0인지 확인합니다.

삭제는 이미 만들어진 불변 백업을 소급 변경하지 않습니다. 백업 보존 정책에 따라 별도로 만료·삭제해야 합니다.

## 개인정보 및 운영 한계

- 저장되는 대화·프로필·답장 본문은 애플리케이션 키로 암호화되지만, 서버와 모델 제공자는 분석 중 복호화된 평문을 처리합니다. 따라서 **종단간 암호화가 아닙니다**.
- 로그에는 대화 원문, 프로필, 프롬프트 또는 모델 응답을 남기지 않으며 스칼라 운영 메타데이터만 허용합니다.
- 임베딩, 데이터베이스 메타데이터와 백업은 별도 인프라 보호가 필요합니다.
- 이 MVP는 공개 다중 사용자 서비스로 설계되거나 검토되지 않았습니다. 인터넷에 직접 노출하지 말고 HTTPS 역방향 프록시, 속도 제한과 암호화된 백업을 사용합니다.

최종 근거는 [MVP 인수 체크리스트](docs/acceptance/mvp-checklist.md)에 기록합니다.
