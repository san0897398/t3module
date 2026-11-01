# UI observation

화면과 구조·조작 기록을 함께 수집하고, 보존한 결과를 조회·비교하는 Node.js 라이브러리와 CLI입니다.

```sh
npm ci
npm test
node dist/cli.js --help
```

`src/index.ts`가 공개 API, `src/cli.ts`가 CLI 진입점입니다. `recipes/`는 연결·관측 설정 예시이며, `tests/`는 합성 자료와 테스트용 연결을 사용합니다. 대화 캡처는 저장소 루트의 `examples/captures/`에 있습니다.

관측 권한과 연결 대상은 실행할 때 명시해야 합니다. 빌드 결과와 실제 관측 데이터는 Git에 포함하지 않습니다. 의존성 출처와 라이선스는 `SOURCES.json`과 `licenses/`에서 확인합니다.
