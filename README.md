# VSCoqComparison

This is the repository with the test suite for our code completion algorithms for the [VSCoq Language Server](https://github.com/coq-community/vscoq).

It works by putting a test within the test setup of VS Code, such that we can use the same sorting and filtering algorithms as real world users would.

The original paper is included in this repository as [Expanding_Coq_with_Type_Aware_Code_Completion.pdf](./Expanding_Coq_with_Type_Aware_Code_Completion.pdf)

## Running the suite

The suite has been run on Arch Linux, but should work on other Unix systems
(and maybe WSL, but that is far from guaranteed).

You need a working install of VSCoq, which includes the `vscoqtop` binary.
You will likely also need a working install of `electron` and `node`, on Arch I used `pacman -S electron19 nodejs` (with `extra` active).

```sh
./setup.sh  # Pulls, links and installs files for vscode and test data
./build.sh  # Takes 2 minutes, but builds vscode for the tests to run
```

If you need to iterate on the tests in [runSuite.test.ts](./vscode/src/vs/editor/contrib/suggest/test/browser/runSuite.test.ts), then:

```sh
./watch.sh  # Compiles vscode in watch mode, which recompiles test in only ~700 ms
./edit.sh   # Opens ./runSuite.test.ts from where it is linked in vscode, allowing for rich editor support
```

In another terminal:

```sh
./run.sh    # Runs the tests via Node
```
