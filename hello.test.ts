/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-import-patterns */
import { spawn } from "child_process";
import {
	readFileSync,
	appendFile,
	open,
	close,
	PathOrFileDescriptor,
} from "fs";
import type { Readable, Writable } from "stream";
import { Event } from "vs/base/common/event";
import { DisposableStore } from "vs/base/common/lifecycle";
import * as languages from "vs/editor/common/languages";
import { LanguageService } from "vs/editor/common/services/languageService";
import {
	ILanguageConfigurationService,
	ResolvedLanguageConfiguration,
} from "vs/editor/common/languages/languageConfigurationRegistry";
import { TextModel } from "vs/editor/common/model/textModel";
import type { IUndoRedoService } from "vs/platform/undoRedo/common/undoRedo";
import {
	createTestCodeEditor,
	ITestCodeEditor,
} from "vs/editor/test/browser/testCodeEditor";
import { ILanguageFeaturesService } from "vs/editor/common/services/languageFeatures";
import { LanguageFeaturesService } from "vs/editor/common/services/languageFeaturesService";
import { ServiceCollection } from "vs/platform/instantiation/common/serviceCollection";
import { ITelemetryService } from "vs/platform/telemetry/common/telemetry";
import { NullTelemetryService } from "vs/platform/telemetry/common/telemetryUtils";
import { ILogService, NullLogService } from "vs/platform/log/common/log";
import {
	InMemoryStorageService,
	IStorageService,
} from "vs/platform/storage/common/storage";
import { MockKeybindingService } from "vs/platform/keybinding/test/common/mockKeybindingService";
import { IKeybindingService } from "vs/platform/keybinding/common/keybinding";
import { IEditorWorkerService } from "vs/editor/common/services/editorWorker";
import { mock } from "vs/base/test/common/mock";
import { ISuggestMemoryService } from "../../browser/suggestMemory";
import { IMenu, IMenuService } from "vs/platform/actions/common/actions";
import { ILabelService } from "vs/platform/label/common/label";
import { IWorkspaceContextService } from "vs/platform/workspace/common/workspace";
import { SuggestController } from "../../browser/suggestController";
import { Position } from "vs/editor/common/core/position";
import { ILanguageService } from "vs/editor/common/languages/language";
import { promisify } from "util";

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
			msg = this.partial + msg;
		}
		try {
			this.enqueueObject(JSON.parse(msg));
			this.partial = "";
		} catch (err) {
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
			res = await this.dequeue<{ method?: string }>();
		}
		return res as T;
	}
}

const TOP_RESULTS = 10;

function appendCsv(
	csv: PathOrFileDescriptor,
	file_name: string,
	algorithm: number | string,
	line: number | string,
	character: number | string,
	keyword: string,
	expected_lemma: string,
	lemma_position: number | string,
	...top_results: string[]
) {
	if (top_results.length < TOP_RESULTS) {
		top_results = [
			...top_results,
			...new Array(TOP_RESULTS - top_results.length).fill(""),
		];
	}
	promisify(appendFile)(
		csv,
		[
			file_name,
			algorithm,
			line,
			character,
			keyword,
			expected_lemma,
			lemma_position,
			...top_results,
		].join(";") + "\n"
	);
}

suite("Test algorithms", function () {
	let model: TextModel;
	const languageFeaturesService = new LanguageFeaturesService();
	let languageService: ILanguageService;
	const disposables = new DisposableStore();
	const completionItems = {
		items: [] as languages.CompletionList["suggestions"],
	};
	let editor: ITestCodeEditor;
	let controller: SuggestController;

	setup(function () {
		languageService = disposables.add(new LanguageService());
		const serviceCollection = new ServiceCollection(
			[ILanguageFeaturesService, languageFeaturesService],
			[ITelemetryService, NullTelemetryService],
			[ILogService, new NullLogService()],
			[IStorageService, new InMemoryStorageService()],
			[IKeybindingService, new MockKeybindingService()],
			[
				IEditorWorkerService,
				new (class extends mock<IEditorWorkerService>() {
					override computeWordRanges() {
						return Promise.resolve({});
					}
				})(),
			],
			[
				ISuggestMemoryService,
				new (class extends mock<ISuggestMemoryService>() {
					override memorize(): void {}
					override select(): number {
						return 0;
					}
				})(),
			],
			[
				IMenuService,
				new (class extends mock<IMenuService>() {
					override createMenu() {
						return new (class extends mock<IMenu>() {
							override onDidChange = Event.None;
							override dispose() {}
						})();
					}
				})(),
			],
			[ILabelService, new (class extends mock<ILabelService>() {})()],
			[
				IWorkspaceContextService,
				new (class extends mock<IWorkspaceContextService>() {})(),
			]
		);
		const onDidChange: Event<any> = Event.None;
		const langConfig: ILanguageConfigurationService = {
			onDidChange,
			register: (x, y) => ({ dispose() {} }),
			_serviceBrand: undefined,
			getLanguageConfiguration(languageId) {
				return new ResolvedLanguageConfiguration("coq", {});
			},
		};
		const no = () => false;
		model = disposables.add(
			new TextModel(
				"",
				"coq",
				TextModel.DEFAULT_CREATION_OPTIONS,
				undefined,
				{
					onDidChange,
					canUndo: no,
					canRedo: no,
					removeElements: () => {},
				} as unknown as IUndoRedoService,
				languageService,
				langConfig
			)
		);
		const provider: languages.CompletionItemProvider = {
			provideCompletionItems() {
				return { suggestions: completionItems.items };
			},
		};
		languageFeaturesService.completionProvider.register(
			{ language: "coq" },
			provider
		);
		editor = disposables.add(
			createTestCodeEditor(model, { serviceCollection })
		);
		controller = editor.registerAndInstantiateContribution(
			SuggestController.ID,
			SuggestController
		);
	});
	teardown(function () {
		disposables.clear();
	});

	test("Test algorithms", async function () {
		const csv = await promisify(open)("../out.csv", "a");
		appendCsv(
			csv,
			"File Name",
			"Algorithm",
			"Line",
			"Character",
			"Keywords Before",
			"Expected Lemma",
			"Lemma",
			"Position",
			...new Array(10).fill("").map((_, i) => `Result ${i + 1}`)
		);
		enum RankingAlgorithm {
			SimpleTypeIntersection = 0,
			SplitTypeIntersection = 1,
			StructuredTypeEvaluation = 2,
		}
		const ranking: RankingAlgorithm = RankingAlgorithm.SimpleTypeIntersection;
		const file = "MoreBasic.v";

		const vsc = spawn(
			"/home/monner/Projects/vscoq/language-server/_build/install/default/bin/vscoqtop",
			[
				"-bt",
				"-coqlib",
				"/home/monner/Projects/vscoq/language-server/_build/default/coq",
			]
		);

		const queue = await new Promise<Queue>((res) => new Queue(res));

		const decoder = new TextDecoder("utf-8");

		vsc.stdout.on("data", (d) => {
			const decoded = decoder.decode(d).split(/Content-Length: \d+\r?\n\r?\n/);
			decoded.forEach(queue.enqueue);
		});
		vsc.stderr.on("data", (d) => {
			console.error(decoder.decode(d));
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
				ranking,
			},
		});

		await queue.dequeue(); // initialize
		await queue.dequeue(); // workspace/configuration

		const contents = readFileSync(`../${file}`, "utf-8");
		const lines = contents.split("\n");

		model.setValue(contents);

		send(vsc, "textDocument/didOpen", {
			textDocument: {
				uri: file,
				text: contents,
			},
		});

		const regex = /(apply|rewrite|rewrite <-) ([a-zA-Z_][a-zA-Z_0-9]*)/;
		const ranks: [number, number][] = [];

		const suggestResolver = { res: (d: unknown) => {} };

		controller.model.onDidSuggest(() => suggestResolver.res(undefined));

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			let search = line.search(regex);
			let tacticStart = 0;
			while (search >= 0) {
				tacticStart += search;
				const [_sentence, tactic, lemma] =
					regex.exec(line.slice(tacticStart)) ?? [];
				const tacticEnd = tacticStart + tactic.length;

				// TODO: Determine whether we use word under cursor on backend
				// ...as completion provider is invoked on every suggest trigger
				send(vsc, "textDocument/completion", {
					textDocument: {
						uri: file,
					},
					position: { line: i, character: tacticEnd },
				});
				const data = await queue.dequeueSkip<{ result: { items: [] } }>();
				// TODO: Time this
				completionItems.items = data["result"]["items"];

				for (let x = 0; x <= lemma.length; x++) {
					// Promise which can be resolved when suggestions are done
					const suggest = new Promise((res) => (suggestResolver.res = res));

					const OFFSET = 2; // position in editor is 1-indexed, and include space
					editor.setPosition(new Position(i + 1, tacticEnd + x + OFFSET));

					controller.triggerSuggest();
					await suggest;
					type Cast = {
						_completionModel: typeof controller.model["_completionModel"];
					};
					const topTen =
						(controller.model as unknown as Cast)._completionModel?.items
							.slice(0, TOP_RESULTS)
							.map(({ textLabel }) => textLabel) ?? [];
					console.log("result: ", topTen);
					const score = 0;
					appendCsv(
						csv,
						file,
						ranking,
						i,
						tacticEnd + x + 1,
						tactic,
						lemma,
						score,
						...topTen
					);
				}

				// console.log(
				// 	search,
				// 	tacticStart,
				// 	tacticEnd,
				// 	JSON.stringify([_sentence, tactic, lemma]),
				// 	line.slice(tacticEnd)
				// );

				search = line.slice(++tacticStart).search(regex);
			}
		}

		await new Promise((res, rej) =>
			setTimeout(() => {
				vsc.kill();
				close(csv, () => res(null));
			}, 1000)
		);
	});
});
