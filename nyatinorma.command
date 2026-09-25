#!/bin/zsh
cd "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
npm start
