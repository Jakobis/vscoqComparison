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

const round = (i: number, ds = 2) => (
	(ds = Math.pow(10, ds)), Math.round(i * ds) / ds
);

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
	partial = "";
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

async function appendCsv(
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
	await promisify(appendFile)(
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

const _ = {
	range(i: number, j?: number) {
		let x = 0;
		if (j !== undefined) {
			x = i;
			i = j;
		}
		return new Array<number>(i - x).fill(i).map(() => x++);
	},
	sum: (items: number[]) => items.reduce((a, b) => a + b),
};

class DoubleAssocWithDefault<T1 extends number, T2 extends number> {
	constructor(
		private map = new Map<T1, Map<T2, number>>(),
		private counts: number[] = []
	) {}

	increment(t1: T1, t2: T2) {
		let m1 = this.map.get(t1);
		if (!m1) {
			m1 = new Map<T2, number>();
			this.map.set(t1, m1);
		}
		m1.set(t2, (m1.get(t2) ?? 0) + 1);
		this.counts[t1] = (this.counts[t1] ?? 0) + 1;
	}

	toString() {
		const res: Record<number, [T2, number][]> = {};
		for (const [k, v] of this.map.entries()) {
			res[k] = [...v.entries()];
			res[k].sort(([i1], [i2]) => i1 - i2);
		}
		return JSON.stringify(res);
	}
	iter() {
		const map = this.map;
		const counts = this.counts;
		const x = function* () {
			for (const [k, v] of map.entries()) {
				yield [counts[k], k, v] as const;
			}
		};
		return x();
	}
}

/**
 * Calculate algorithm score based on [[Robbes & Lanza]](https://www.researchgate.net/publication/44848048).
 *
 * The algorithm is modified, s.t. all prefix lengths still matter when scoring,
 * especially the case where no part of the word is typed yet.
 *
 * For a prefix = 0, grade matters ~32.2%.
 * For a prefix = 1, grade matters ~16.1%.
 * For a prefix = 2, grade matters ~10.7%, etc.
 *
 * in this way, our algorithm matters at least probably 50%, as VSCode
 * filter/sort on word distance is pretty aggresive, prioritizing beginning of word
 * over part of word over sorting order.
 *
 * Returns [score: `number`, grades: `number[]`]
 */
function score(ranks: DoubleAssocWithDefault<number, number>) {
	const grades: number[] = [];
	for (const [attempts, prefixLength, map] of ranks.iter()) {
		const grade_i =
			_.sum(_.range(10).map((j) => (map.get(j) ?? 0) / (j + 1))) / attempts;
		grades[prefixLength] = grade_i;
	}
	const score =
		(_.sum(grades.map((G_i, i) => G_i / (i + 1))) /
			_.sum(_.range(grades.length).map((k) => 1 / (k + 1)))) *
		100;
	return [score, grades] as const;
}

enum RankingAlgorithm {
	SimpleTypeIntersection,
	SplitTypeIntersection,
	StructuredTypeEvaluation,
	SelectiveUnification,
	SelectiveSplitUnification,
}

const rankingAlgortihms = [
	RankingAlgorithm.SimpleTypeIntersection,
	RankingAlgorithm.SplitTypeIntersection,
	RankingAlgorithm.StructuredTypeEvaluation,
	RankingAlgorithm.SelectiveUnification,
	RankingAlgorithm.SelectiveSplitUnification,
];

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
		// process.stdin.addListener("data", console.log);
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
		const append = promisify(appendFile);
		const now = new Date().toISOString();
		const csv = await promisify(open)(`../out/${now}.csv`, "a");
		appendCsv(
			csv,
			"File Name",
			"Algorithm",
			"Line",
			"Character",
			"Keywords Before",
			"Expected Lemma",
			"Lemma",
			"Index",
			...new Array(10).fill("").map((_, i) => `Result ${i + 1}`)
		);
		const scoreCsv = await promisify(open)(`../out/scores-${now}.csv`, "a");
		await append(scoreCsv, "File Name;Algorithm;Score\n");
		for (const file of ["MoreBasic.v"]) {
			for (const ranking of rankingAlgortihms) {
				const score = await runTest(csv, ranking, file);
				await append(
					scoreCsv,
					`${file};${RankingAlgorithm[ranking]};${score}\n`
				);
			}
		}
		await new Promise((res) => (close(csv), close(scoreCsv), res(null)));
	});
	async function runTest(
		csv: PathOrFileDescriptor,
		ranking: RankingAlgorithm,
		file: string
	) {
		console.log(`Running ${RankingAlgorithm[ranking]} on ${file}...`);

		const coqLibPath = process.env.COQLIB ?? "";

		const vsc = spawn("vscoqtop", [
			"-bt",
			"-coqlib",
			coqLibPath,
		]);

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
		const ranks = new DoubleAssocWithDefault<number, number>();

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
				// as completion provider is invoked on every suggest trigger
				await new Promise((res) => setTimeout(res, 100));
				send(vsc, "textDocument/completion", {
					textDocument: {
						uri: file,
					},
					position: { line: i, character: tacticEnd },
				});
				const data = await queue.dequeueSkip<{ result: { items: [] } }>();
				// TODO: Time this
				completionItems.items = data["result"]["items"];

				for (
					let lemmaPosition = 0;
					lemmaPosition <= lemma.length;
					lemmaPosition++
				) {
					// Promise which can be resolved when suggestions are done
					const suggest = new Promise((res) => (suggestResolver.res = res));

					const OFFSET = 2; // position in editor is 1-indexed, and include space
					editor.setPosition(
						new Position(i + 1, tacticEnd + lemmaPosition + OFFSET)
					);

					controller.triggerSuggest();
					await suggest;
					type Cast = {
						_completionModel: typeof controller.model["_completionModel"];
					};
					const items =
						(controller.model as unknown as Cast)._completionModel?.items ?? [];
					const topTen = items
						.slice(0, TOP_RESULTS)
						.map(({ textLabel }) => textLabel);

					const resultIndex = items.findIndex(
						({ textLabel }) => textLabel === lemma
					);
					ranks.increment(lemmaPosition, resultIndex);

					await appendCsv(
						csv,
						file,
						RankingAlgorithm[ranking],
						i + 1,
						tacticEnd + lemmaPosition + OFFSET,
						tactic,
						lemma,
						resultIndex,
						...topTen
					);
				}

				search = line.slice(++tacticStart).search(regex);
			}
		}

		const [S, grades] = score(ranks);

		console.log(
			`${RankingAlgorithm[ranking]} scored ${round(S)}, grades ${JSON.stringify(
				grades.map((i) => round(i))
			)}`
		);

		await new Promise((res) =>
			setTimeout(() => {
				vsc.kill();
				res(null);
			}, 500)
		);

		return S;
	}
});
