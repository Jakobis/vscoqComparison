import json
import re
import itertools
import subprocess

from lsp import Connection

vscoqtop = subprocess.Popen("vscoqtop", stdin=subprocess.PIPE, stdout=subprocess.PIPE)
conn = Connection("client")

def sendToCoqtop(name, jsonData):
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": name,
        "params": jsonData
    }
    data = conn.send_json(payload)
    vscoqtop.stdin.write(data)


def receiveFromCoqtop():
    data = vscoqtop.stdout.read()
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
        print(f"Average value for autocomplete with {key} letters known: {sum(group) / len(group)}")



def benchmark(path):
    with open(path) as file:
        #initialize
        initializeJson = json.dumps(
            {
                "rootPath": "/home/jakobis/Documents/Skole/Prove/ProVe/testing",
                "rootUri": "file:///home/jakobis/Documents/Skole/Prove/ProVe/testing"
            })
        sendToCoqtop("initialize", initializeJson)

        #open document
        contents = file.read()
        openJson = json.dumps(
            {
                "textDocument": {
                    "uri": path,  #todo ask if I should do anything to make the path look like this '"file:///home/jakobis/Documents/Skole/Prove/ProVe/testing/test.v",'
                    "text": contents
                }
            }
        )
        sendToCoqtop("textDocument/didOpen", openJson)

        #benchmark
        lines = contents.split("\n")
        keywords = ["apply", "rewrite", "rewrite <-"]
        regex = f"({'|'.join(keywords)})" + r" (?<lemma>([a-zA-Z_][a-zA-Z_0-9]*)) "
        ranks = [] # a list of tuples with results. First part of the tuple is how many letters it had to work with, second part is the score of the suggestions
        for lineNumber, line in enumerate(lines):
            groups = [(m.group("lemma"), m.span()) for m in re.finditer(regex, line)]
            for word, span in groups:
                for i in range(span[0], span[1]):
                    completionJson = json.dumps(
                        {
                            "textDocument": {
                                "uri": path
                            },
                            "position": {"line": line, "character": i} #todo check if python can convert ints to string in json
                        }
                    )
                    sendToCoqtop("textDocument/completion", completionJson)
                    receivedJson = receiveFromCoqtop()
                    data = json.loads(receivedJson)
                    items = [item["label"] for item in data["items"]][:10]
                    currentScore = score(word, items)
                    ranks.append((i, currentScore))
        printScores(ranks)



def test():
    conn = Connection("client")
    data = conn.send_json({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": ""})
    print(data)
test()