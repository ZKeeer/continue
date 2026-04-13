#!/bin/bash -x
export CONTINUE_DOWNLOAD_BINARY=NOTEXISTS

cd ~/continue-v1.3.19-vscode
echo '======================= step 1: build package =================='
node ./scripts/build-packages.js

echo '======================= step 2: build core    =================='
cd core
npm install
npm ci
npm i vectordb

echo '======================= step 3: build gui     =================='
cd ../gui
npm install
npm ci
export NODE_OPTIONS="--max-old-space-size=4096"
npm run build

echo '======================= step 4: build vscode  =================='
cd ../extensions/vscode
npm install
npm ci
npm run prepackage
npm install -f esbuild
npm run package
npx vsce package --no-dependencies --target linux-x64
ls -lrta *.vsix
rsync -avP *.vsix /zkqd-vmshare/continue-release/

echo '======================= step 5: build binary  =================='
cd ../../binary
npm install
npm ci
npm run build

echo '======================= step 6: build intellij=================='
cd ../extensions/intellij
dos2unix ./gradlew
./gradlew publishPlugin --info --stacktrace
ls -lrta build/distributions/
rsync -avP *.zip /zkqd-vmshare/continue-release/
