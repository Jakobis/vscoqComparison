git submodule init
git submodule update
ln -s $(pwd)/hello.test.ts $(pwd)/vscode/src/vs/editor/contrib/suggest/test/browser/hello.test.ts

cd vscode
yarn install
