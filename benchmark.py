import json
import re
import itertools
from subprocess import Popen, PIPE
from os import getcwd
from os.path import exists
from sys import argv
from shutil import which
from io import TextIOWrapper
ID = 1


def send(vsc, method, params):
    global ID
    j = json.dumps({
        "jsonrpc": "2.0", "id": ID, "method": method, "params": params
    })
    ID += 1
    msg = f"Content-Length: {len(j)}\n\n{j}"
    # msg = bytes(msg, "utf-8")

    vsc.stdin.write(msg)
    vsc.stdin.flush()


def get(vsc):
    vsc.stdout.read(len("Content-Length: "))
    leng = vsc.stdout.readline().strip()
    vsc.stdout.readline()
    out = vsc.stdout.read(int(leng))
    return json.loads(out)


def send_respond(vsc, method, params):
    send(vsc, method, params)
    return get(vsc)


def get_skip(vsc):
    result = get(vsc)
    while ("method" in result and (result["method"] == "vscoq/updateHighlights" or result["method"] == "textDocument/publishDiagnostics")):
        result = get(vsc)
    return result


def score(word, items, index):
    if word not in items:
        return 0
    return 1 / (index + 1)


def printScores(ranks):
    ranks.sort()
    for key, group in itertools.groupby(ranks, lambda x: x[0]):
        group = [x[1] for x in group]
        print(
            f"Average value for autocomplete with {key} letters known: {sum(group) / len(group)}")


def appendCsv(
    csv: TextIOWrapper,
    file_name, algorithm, line: int, character: int,
    keyword, expected_lemma, lemma_position: int,
    top_10_results: list[str]
):
    csv.write(";".join([file_name, algorithm, str(line), str(character),
                        keyword, expected_lemma, str(lemma_position), *top_10_results]) + "\n")


def benchmark(file_name, algo, vsc, csv):
    # initialize
    initResponse = send_respond(vsc, "initialize", {
        "processId": None, "rootUri": None,
        "workspaceFolders": getcwd(),
        "capabilities": {},
        "initializationOptions": {
            "proof": {
                "delegation": "None",
                "workers": 1,
                "mode": 1,
            },
            "completionAlgorithm": algo,
        }
    })
    print(initResponse)
    workspaceResponse = get(vsc)
    print(workspaceResponse)
    # send("initialized", {}) #  doesn't matter lol

    contents = ""
    lines = []
    with open(file_name) as file:
        contents = file.read()
        lines = contents.split("\n")

    # open document
    openJson = {
        "textDocument": {
            "uri": file_name,  # todo ask if I should do anything to make the path look like this '"file:///home/jakobis/Documents/Skole/Prove/ProVe/testing/test.v",'
            "text": contents
        }
    }
    send(vsc, "textDocument/didOpen", openJson)

    # benchmark
    regex = r"(apply|rewrite|rewrite <-) (?P<lemma>([a-zA-Z_][a-zA-Z_0-9]*))"
    ranks = []  # a list of tuples with results. First part of the tuple is how many letters it had to work with, second part is the score of the suggestions
    for lineNumber, line in enumerate(lines):
        groups = [(m.group(1), m.group("lemma"), m.span("lemma"))
                  for m in re.finditer(regex, line)]
        for tactic, word, span in groups:
            print(word, span, tactic)
            for i in range(span[0], span[1]):
                completionJson = {
                    "textDocument": {
                        "uri": file_name
                    },
                    # todo check if python can convert ints to string in json
                    "position": {"line": lineNumber, "character": i}
                }
                send(vsc, "textDocument/completion", completionJson)
                data = get_skip(vsc)
                items = [item["label"]
                         for item in data["result"]["items"]][:10]
                lemma_position = items.index(word) if word in items else -1
                appendCsv(
                    csv,
                    file_name, algo, lineNumber, i,
                    tactic, word, lemma_position,
                    items
                )
                currentScore = score(word, items, lemma_position)
                ranks.append((i - span[0], currentScore))
    printScores(ranks)


if __name__ == "__main__":
    if len(argv) < 4:
        print(
            "Usage: benchmark.py <benchfile> <algorithm> <outfile> [<vscoqtop path>]")
        print(len(argv))
        exit(1)
    _, bench, algo, csvFile, *rest = argv
    vscoqtop_path = "vscoqtop"
    if len(rest) > 0:
        vscoqtop_path = rest[0]
        if not exists(vscoqtop_path):
            vscoqtop_path = which(vscoqtop_path)
        if not exists(vscoqtop_path or ""):
            print(
                f"vscoqtop path must exist if specified! Couldn't find '{rest[0]}'")
            exit(1)
    csv_header = ""
    if not exists(csvFile):
        csv_header = f"File Name;Algorithm;Line;Character;Keywords Before;Expected Lemma;Lemma Position;Result {';Result '.join(map(str,range(1, 11)))}\n"
    with open(csvFile, "a") as csv:
        with Popen([vscoqtop_path, "-bt"], stdin=PIPE, stdout=PIPE, stderr=PIPE, text=True) as vsc:
            print(vsc.args)
            csv.write(csv_header)
            benchmark("MoreBasic.v", algo, vsc, csv)
