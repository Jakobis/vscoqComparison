import json
import re
import itertools
import subprocess
from subprocess import Popen, PIPE
from lsp import Connection
conn = Connection("client")
ID = 1
vsc = Popen(
    ["vscoqtop", "-bt"], stdin=PIPE, stdout=PIPE, stderr=PIPE, text=True)


def send(method, params):
    global ID
    j = json.dumps({
        "jsonrpc": "2.0", "id": ID, "method": method, "params": params
    })
    ID += 1
    msg = f"Content-Length: {len(j)}\n\n{j}"
    # msg = bytes(msg, "utf-8")

    vsc.stdin.write(msg)
    vsc.stdin.flush()


def get():
    vsc.stdout.read(len("Content-Length: "))
    leng = ""
    c = ""
    while c != "\n":
        leng += c
        c = vsc.stdout.read(1)
    vsc.stdout.read(len("\n"))
    out = vsc.stdout.read(int(leng))
    return out


def send_respond(method, params):
    send(method, params)
    return get()


def sendToCoqtop(name, jsonData):
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": name,
        "params": jsonData
    }
    data = conn.send_json(payload)
    vsc.stdin.write(data)


def receiveFromCoqtop():
    data = vsc.stdout.read()
    stuff = conn.receive(data)
    return


def score(word, items):
    if word not in items:
        return 0
    return 1 / (items.index(word) + 1)


def printScores(ranks):
    ranks.sort()
    for key, group in itertools.groupby(ranks, lambda x: x[0]):
        group = list(group)
        print(
            f"Average value for autocomplete with {key} letters known: {sum(group) / len(group)}")


def benchmark(path):
    with open(path) as file:
        # initialize
        initResponse = send_respond("initialize", {
            "processId": None, "rootUri": None,
            "workspaceFolders": "/home/monner/Projects/vscoqComparison/",
            "capabilities": {},
            "initializationOptions": {
                "proof": {
                    "delegation": "None",
                    "workers": 1,
                    "mode": 1,
                }
            }
        })
        workspaceResponse = get()
        print(f"{initResponse=}")
        print(f"{workspaceResponse=}")
        # send("initialized", {}) #  doesn't matter lol

        # open document
        contents = file.read()
        openJson = {
            "textDocument": {
                "uri": path,  # todo ask if I should do anything to make the path look like this '"file:///home/jakobis/Documents/Skole/Prove/ProVe/testing/test.v",'
                "text": contents
            }
        }
        send("textDocument/didOpen", openJson)
        # print(vsc.poll())
        print(get())

        # benchmark
        lines = contents.split("\n")
        keywords = ["apply", "rewrite", "rewrite <-"]
        regex = f"({'|'.join(keywords)})" + \
            r" (?P<lemma>([a-zA-Z_][a-zA-Z_0-9]*)) "
        ranks = []  # a list of tuples with results. First part of the tuple is how many letters it had to work with, second part is the score of the suggestions
        for lineNumber, line in enumerate(lines):
            groups = [(m.group("lemma"), m.span())
                      for m in re.finditer(regex, line)]
            for word, span in groups:
                for i in range(span[0], span[1]):
                    completionJson = json.dumps(
                        {
                            "textDocument": {
                                "uri": path
                            },
                            # todo check if python can convert ints to string in json
                            "position": {"line": line, "character": i}
                        }
                    )
                    sendToCoqtop("textDocument/completion", completionJson)
                    receivedJson = receiveFromCoqtop()
                    data = json.loads(receivedJson)
                    items = [item["label"] for item in data["items"]][:10]
                    currentScore = score(word, items)
                    ranks.append((i, currentScore))
        printScores(ranks)


benchmark("Basics.v")
# try:
# except:
#     pass
# print(vsc.stderr.read())
