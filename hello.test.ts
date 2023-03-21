/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from "assert";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import type { Readable, Writable } from "stream";
import { EditorOptions } from "vs/editor/common/config/editorOptions";
import { IPosition } from "vs/editor/common/core/position";
import * as languages from "vs/editor/common/languages";
import { CompletionModel } from "vs/editor/contrib/suggest/browser/completionModel";
import {
	CompletionItem,
	provideSuggestionItems,
} from "vs/editor/contrib/suggest/browser/suggest";
import { WordDistance } from "vs/editor/contrib/suggest/browser/wordDistance";

export function createSuggestItem(
	label: string | languages.CompletionItemLabel,
	overwriteBefore: number,
	kind = languages.CompletionItemKind.Property,
	incomplete: boolean = false,
	position: IPosition = { lineNumber: 1, column: 1 },
	sortText?: string,
	filterText?: string
): CompletionItem {
	const suggestion: languages.CompletionItem = {
		label,
		sortText,
		filterText,
		range: {
			startLineNumber: position.lineNumber,
			startColumn: position.column - overwriteBefore,
			endLineNumber: position.lineNumber,
			endColumn: position.column,
		},
		insertText: typeof label === "string" ? label : label.label,
		kind,
	};
	const container: languages.CompletionList = {
		incomplete,
		suggestions: [suggestion],
	};
	const provider: languages.CompletionItemProvider = {
		provideCompletionItems(): any {
			return;
		},
	};

	return new CompletionItem(position, suggestion, container, provider);
}
let ID = 1;
type Vsc = { stdin: Writable; stdout: Readable };
function send(vsc: Vsc, method: unknown, params: unknown) {
	const msg = {
		jsonrpc: "2.0",
		id: ID,
		method: method,
		params: params,
	};
	ID += 1;
	const txt = JSON.stringify(msg);
	vsc.stdin.write(`Content-Length: ${txt.length}\n\n${txt}`);
}

type LinkedPromise = { data: unknown; next: Promise<LinkedPromise> };

class Queue {
	private queue: Promise<LinkedPromise>;
	private resolve: (d: LinkedPromise) => void = () => {};
	private skipMethods = [
		"vscoq/updateHighlights",
		"textDocument/publishDiagnostics",
	];
	private partial = "";
	constructor(queueReady: (d: Queue) => void) {
		this.queue = new Promise<LinkedPromise>((res) => {
			this.resolve = res;
			queueReady(this);
		});
	}
	enqueue = (msg: string) => {
		if (
			msg.includes("vscoq/updateHighlights") ||
			msg.includes("textDocument/publishDiagnostics")
		) {
			return;
		}
		if (this.partial) {
			// console.log("partial", this.partial.slice(this.partial.length - 200), msg.slice(0, 200), "\n...\n", msg.slice(msg.length - 200));
			msg = this.partial + msg;
		}
		try {
			this.enqueueObject(JSON.parse(msg));
			this.partial = "";
		} catch (err) {
			// const position = Number(
			// 	(err as SyntaxError).message.match(/position (\d+)/)?.[1]
			// );
			// console.error(err, msg.slice(position - 100, position + 200));
			this.partial = msg;
		}
	};
	private enqueueObject = (obj: unknown) => {
		const oldRes = this.resolve;
		const newPromise = new Promise<LinkedPromise>(
			(res) => (this.resolve = res)
		);
		oldRes({ data: obj, next: newPromise });
	};
	async dequeue<T>(): Promise<T> {
		const { data, next } = await this.queue;
		this.queue = next;
		return data as T;
	}
	async dequeueSkip<T>() {
		let res = await this.dequeue<{ method?: string }>();
		while (res?.method && this.skipMethods.includes(res.method)) {
			console.log("skipped", res.method);
			res = await this.dequeue<{ method?: string }>();
		}
		return res as T;
	}
}

suite("Test algorithms", function () {
	// const defaultOptions = <InternalSuggestOptions>{
	// 	insertMode: 'insert',
	// 	snippetsPreventQuickSuggestions: true,
	// 	filterGraceful: true,
	// 	localityBonus: false,
	// 	shareSuggestSelections: false,
	// 	showIcons: true,
	// 	showMethods: true,
	// 	showFunctions: true,
	// 	showConstructors: true,
	// 	showDeprecated: true,
	// 	showFields: true,
	// 	showVariables: true,
	// 	showClasses: true,
	// 	showStructs: true,
	// 	showInterfaces: true,
	// 	showModules: true,
	// 	showProperties: true,
	// 	showEvents: true,
	// 	showOperators: true,
	// 	showUnits: true,
	// 	showValues: true,
	// 	showConstants: true,
	// 	showEnums: true,
	// 	showEnumMembers: true,
	// 	showKeywords: true,
	// 	showWords: true,
	// 	showColors: true,
	// 	showFiles: true,
	// 	showReferences: true,
	// 	showFolders: true,
	// 	showTypeParameters: true,
	// 	showSnippets: true,
	// };

	let model: CompletionModel;

	setup(function () {
		model = new CompletionModel(
			[
				createSuggestItem("foo", 3),
				createSuggestItem("Foo", 3),
				createSuggestItem("foo", 2),
			],
			1,
			{
				leadingLineContent: "foo",
				characterCountDelta: 0,
			},
			WordDistance.None,
			EditorOptions.suggest.defaultValue,
			EditorOptions.snippetSuggestions.defaultValue,
			undefined
		);
	});

	test("Test algorithms", async function () {
		const algo = "algo";
		const file = "MoreBasic.v";

		const vsc = spawn("vscoqtop");

		const queue = await new Promise<Queue>((res) => new Queue(res));

		const decoder = new TextDecoder("utf-8");

		vsc.stdout.on("data", (d) => {
			const decoded = decoder.decode(d).split(/Content-Length: \d+\r?\n\r?\n/);
			decoded.forEach(queue.enqueue);
		});

		send(vsc, "initialize", {
			processId: null,
			rootUri: null,
			workspaceFolders: process.cwd(),
			capabilities: {},
			initializationOptions: {
				proof: {
					delegation: "None",
					workers: 1,
					mode: 1,
				},
				completionAlgorithm: algo,
			},
		});

		await queue.dequeue(); // initialize
		await queue.dequeue(); // workspace/configuration

		const contents = readFileSync(`../${file}`, "utf-8");
		const lines = contents.split("\n");

		send(vsc, "textDocument/didOpen", {
			textDocument: {
				uri: file,
				text: contents,
			},
		});

		const regex = /(apply|rewrite|rewrite <-) ([a-zA-Z_][a-zA-Z_0-9]*)/;
		const ranks = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			let search = line.search(regex);
			let tacticStart = 0;
			while (search >= 0) {
				tacticStart += search;
				const [sentence, tactic, lemma] =
					regex.exec(line.slice(tacticStart)) ?? [];
				const tacticEnd = tacticStart + tactic.length;

				send(vsc, "textDocument/completion", {
					textDocument: {
						uri: file,
					},
					position: { line: i, character: tacticEnd },
				});

				const data = await queue.dequeueSkip<{ result: { items: [] } }>();
				console.log(JSON.stringify(data["result"]["items"].slice(0, 10)));

				// provideSuggestionItems();

				console.log(
					search,
					tacticStart,
					tacticEnd,
					line[tacticEnd],
					JSON.stringify([sentence, tactic, lemma])
				);

				search = line.slice(++tacticStart).search(regex);
			}
			// const m = line.match(regex) || [];
			// m.forEach((x) => console.log(x));
		}

		await new Promise((res, rej) =>
			setTimeout(() => {
				console.log("Killed at", process.cwd());
				vsc.kill();
				res(null);
			}, 1000)
		);

		const itemsNow = model.items;
		let itemsThen = model.items;
		assert.ok(itemsNow === itemsThen);

		// still the same context
		model.lineContext = { leadingLineContent: "foo", characterCountDelta: 0 };
		itemsThen = model.items;
		assert.ok(itemsNow === itemsThen);

		// different context, refilter
		model.lineContext = { leadingLineContent: "foo1", characterCountDelta: 1 };
		itemsThen = model.items;
		assert.ok(itemsNow !== itemsThen);
	});
});
