# nyatinorma-omp — 공통 sleepwalk 호스트

원본 `runExecution` / `runAct`를 omp Eval에 연결한다. **제어 로직은 nyatinorma, 실제 캡처·입력은 omp `computer`**다. 독립 실행의 Cua 드라이버나 별도 컴퓨터 세션을 만들지 않는다.

상위 모델은 목표·후보·완료 조건과 새 상황의 판단을 제공한다. SELECT 모델은 후보를 고르고, 공통 실행기는 새 화면으로 대상을 검증한 뒤 입력하고 결과를 확인한다. 판정 모델만 로컬로 선택해도 계획·후보 갱신까지 자동화되지는 않는다.

## 설치와 시작

저장소 루트에서 Node.js/npm 및 Bun으로 실행한다:

```sh
npm ci
npm run build:omp
omp plugin link ./integrations/omp
```

omp를 재시작하고 `nyatinorma_setup`을 호출한다. 반환된 bootstrap 중 하나를 Eval에서 **한 번만** 실행하고 `ny`를 재사용한다. setup이 제공한 `cancellationFile`을 유지해야 새 사용자 입력·세션 종료 시 취소가 연결된다. 번들은 file URL로 로드하며 설치된 Sharp의 네이티브 의존성을 사용한다.

이 폴더가 정본이다. 이전 별도 `nyatinorma-omp` 저장소 및 `observe/choose/click/verify` API는 사용하지 않는다. 빌드 후 Eval 모듈은 캐시되므로 미확정 입력이 남은 상태에서 커널·런타임을 교체하지 않는다.

## 판정 경로

기본은 omp `judge()`다. setup bootstrap의 옵션에 아래 `decision`을 지정하면 공통 System One 연결부로 판정한다. 예시 모델은 서버에 미리 설치되어 있어야 한다.

```js
decision: {
  mode: 'systemone',
  url: 'http://127.0.0.1:11434',
  model: 'clef-flash:9b',
  wire: 'ollama',
  fallback: true,
  timeoutMs: 30000
}
```

- Ollama는 `/v1/systemone`의 top-level `images`, Jev는 `wire:'typesafe'`의 asset 참조를 사용한다. 전역 모델·GPU·컨텍스트 설정은 바꾸지 않는다.
- 통신·응답 오류는 기본적으로 omp `judge`로 전환한다. `fallback:false`는 전환을 막는다. 낮은 점수와 사용자 취소는 폴백 사유가 아니다.
- `decisionRoute`에서 실제 모델·경로·폴백을 확인한다. host judge 내부 제공자 선택은 omp 소유이며, 폴백 응답을 원래 요청 모델의 답으로 기록하지 않는다. 화면이 선택한 제공자에 전달되므로 항상 로컬 처리라고 가정하지 않는다.
- omp 18.18.0의 native typesafe d3 이미지 판정은 직접 Ollama 호출과 다른 결과를 보였다. 이 어댑터의 명시적 System One 경로를 사용하며 omp 자체 이미지 전달을 고쳤다고 주장하지 않는다.

`storageDir`의 기본값은 번들 옆 `state/`다. 원본 앱의 활성 실행과 분리해 continuation·캡처를 보관한다. `trace(event)`를 지정하면 선택 점수와 검증 이벤트를 받을 수 있다. 기본 경로 메타데이터만으로 과거 판정 점수를 복원할 수는 없다.

## 작은 목표와 후보

최신 `computer.window(...)`에서 확인한 창 ID를 사용한다. 일반 UI의 의미적 컨트롤은 AX가 적합할 수 있다.

```js
const result = await ny.wait({
  window: targetWindowId,
  goal: '현재 작업이 끝날 때까지 관찰',
  until: '완료 화면이 명확히 표시된다',
  maxSeconds: 30
});
```

`act`는 클릭·드래그를, `scroll`은 드래그만 허용한다. 후보에는 정확한 대상·실행 조건·기대 결과를 준다. 다음 좌표는 형식 예시이며 실화면에 재사용하면 안 된다:

```js
const result = await ny.act({
  window: targetWindowId,
  goal: '확인된 항목을 연다',
  until: '해당 항목의 상세 화면이 보인다',
  candidates: {
    description: '현재 항목 목록',
    actions: [{
      id: 'open', kind: 'click', label: '항목 열기',
      target: '정확한 항목 이름',
      when: '해당 항목이 현재 화면에 있고 가려지지 않음',
      expectation: '해당 항목의 상세 화면이 보임',
      preparedAction: {
        id: 'open', kind: 'click', label: '항목 열기', intent: '상세 화면 열기',
        box: {x: 0.45, y: 0.70, width: 0.10, height: 0.04}
      }
    }]
  },
  maxActions: 1,
  maxSeconds: 45
});
```

- `preparedAction.id`는 후보 ID와 같아야 한다. 좌표를 제공해도 대상 의미 검증은 생략하지 않는다. 생략하면 공통 시각 탐색을 사용할 수 있다.
- `box`는 **전체 스크린샷 기준 0–1**, 중심이 입력점이다. 확대 이미지 좌표와 섞지 않는다. PNG와 입력 크기가 다르면 `coordinateWidth/coordinateHeight`로 변환한다.
- 드래그 후보는 `kind:'drag'`, `drag:{surface:'목록 영역',direction:'up',amount:'large'}`를 사용한다. 준비된 드래그에는 시작 `box`와 끝 `to:{x,y}`를 준다. 방향은 콘텐츠가 아니라 포인터 기준이다.
- `candidates`는 초기 배치, `supplier(context)`는 새 후보가 필요할 때의 콜백, 선택적 `generate(prompt,image,signal)`는 ACT 후보 생성기다. 제공된 경로가 없는 새 화면에서는 `needs_decision`으로 돌아온다. 후보를 매 단계 재생성하지 않는다.

## 결과·재개·입력 보호

| 상태 | 의미 |
|---|---|
| `done` | 완료 조건을 확인했다는 모델 판정. 실제 화면과 함께 검토 |
| `yielded` | 예산 종료. continuation으로 재개 가능 |
| `needs_decision` | 후보·해석·미확정 결과에 대한 상위 판단 필요 |
| `stopped` / `error` | 먼저 `lastInput`을 확인. 입력 반복 금지 |

```js
console.log(await ny.status());
ny.stop();
const continued = await ny.resume({resume: result.continuationId});
```

`resume`에 새 `candidates`와 `constraints`를 줄 수 있다. 기존 후보·탐색 기억·드래그 전용 제한·마감·미확정 입력은 보존된다. 입력 직전에 상태를 기록하며 예외·타임아웃 후에는 **관찰로 결과부터 확인하고 재전송하지 않는다**. 같은 입력 범위의 다른 런타임도 이를 우회할 수 없다. 직접 `computer` 호출은 보호 밖이며 미확정 입력을 우회하는 수단이 아니다.

`stop()`·`signal`·setup 취소 marker는 추가 입력과 진행 중 판정을 중단하지만 이미 보낸 OS 입력이나 앱의 자동 진행을 되돌리지는 않는다. 모든 Escape/호스트 인터럽트가 marker와 같다고 가정하지 않는다. 창 ID가 바뀌면 과거 좌표를 새 창에 보내지 않는다. 권한 변경·전송·결제 등의 승인은 상위 모델과 omp 승인 절차가 담당하며 후보나 점수는 권한이 아니다.

가려지거나 비활성인 창은 정상 사용 조건이다. 어댑터는 창을 앞으로 올리거나 자체적으로 foreground/takeover 재시도를 하지 않는다. 기존 드라이버의 경고는 보존한다. 최소화·렌더링 정지와 가림은 다르며, 전달 성공만으로 UI 변경이나 포커스 유지를 주장하지 않는다.

## 검증과 한계

Windows / omp 18.18.0에서 확인한 범위:

- 타입 검사, 테스트 126개, omp 빌드, 새 Eval 커널에서 설치 링크를 통한 네이티브 이미지 처리 로딩 통과.
- d3로 조건 대기, 스크롤 continuation 재개, 대상 클릭 확인. 완전히 가린 테스트 창에서도 캡처·입력·대기가 작동했고 실행 전후 포그라운드 창 ID가 같았다. 취소 marker로 활성 대기를 중단했다.
- 실제 d3 텍스트·이미지 판정과 legacy Qwen SELECT, 존재하지 않는 native 모델의 HTTP 오류 후 기존 SELECT 전환을 확인했다. Jev는 계약 테스트만 통과했으며 인증된 실서버는 미검증이다.
- MuMu 게임 두 판은 `clef-flash:9b` 판정 39회, 폴백 없이 완료했다. 첫 상대 선택과 결과 나가기 두 번은 상위 모델이 직접 클릭했고 전투 시작 결과도 보완 판단이 필요했다. 완전 무개입 성공으로 계산하지 않는다.
- 같은 기록 화면에서 d3 4b는 정상 대상의 점수 차이가 부족했고, d3 9b는 잘못 표시한 잠긴 버튼을 승인했다. clef-flash 9b는 원래 질문의 정상/잠긴 버튼 사례를 구분했지만 축약 질문에서는 정상 버튼을 거절했다. 이는 제한된 사례이지 모델 순위나 성공률 측정이 아니다.

점수는 보정된 성공 확률이 아니다. 질문 축약·기준 완화는 정상 사례뿐 아니라 잘못된 좌표·잠긴 대상도 검증해야 한다. SELECT 이후 단순 픽셀 변화로 다시 거절하지 않지만 마지막 캡처와 입력은 원자적이지 않다. 모델 오판, 앱별 비활성 렌더링, 장기 자율 실행의 한계는 남는다.
