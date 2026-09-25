#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .nyatinorma/bin
xcrun swiftc -parse-as-library -O native/Bridge.swift -o .nyatinorma/bin/nyatinorma-macos
app='Nyatinorma Bridge.app'
mkdir -p "$app/Contents/MacOS"
cp .nyatinorma/bin/nyatinorma-macos "$app/Contents/MacOS/nyatinorma-macos"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.nyatinorma.bridge</string>
<key>CFBundleName</key><string>Nyatinorma Bridge</string>
<key>CFBundleExecutable</key><string>nyatinorma-macos</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$app"
