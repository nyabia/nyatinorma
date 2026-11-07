// SPDX-License-Identifier: MIT OR Apache-2.0
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
declare const NYATINORMA_SHARP_ADDON_PATH:string;
// JS 의존성은 번들에 넣고, 네이티브 모듈만 빌드 시 확인한 상대 파일 경로로 연다.
// omp의 컴파일된 Bun에서 패키지 이름 해석은 실패해도 정확한 .node 파일 로딩은 가능하다.
const requireNative=createRequire(import.meta.url);
export default requireNative(fileURLToPath(new URL(NYATINORMA_SHARP_ADDON_PATH,import.meta.url)));
