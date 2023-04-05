git submodule init
git submodule update
ln -s $(pwd)/runSuite.test.ts $(pwd)/vscode/src/vs/editor/contrib/suggest/test/browser/runSuite.test.ts

cd vscode
yarn install
