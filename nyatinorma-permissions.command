#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
npm run permissions
echo '권한 설정 후 nyatinorma.command를 실행하세요.'
read -k 1 '?아무 키나 누르면 닫힙니다. '
