/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-import-patterns */
import { spawn } from "node:child_process";
import {
	readFileSync,
	appendFile,
	open,
	close,
	PathOrFileDescriptor,
	opendirSync,
	Dirent,
} from "node:fs";
import type { Readable, Writable } from "node:stream";
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
import { promisify } from "node:util";

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
	const txt = JSON.stringify(msg);
	const encoded = Buffer.from(txt, "utf8");
	vsc.stdin.write(`Content-Length: ${encoded.length}\n\n${encoded}`);
	return ID++;
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
		// console.log(
		// 	this.partial.slice(0, 300),
		// 	this.partial.slice(this.partial.length - 200)
		// );
		if (
			msg.includes("vscoq/updateHighlights") ||
			msg.includes("textDocument/publishDiagnostics")
		) {
			return;
		}
		try {
			this.enqueueObject(JSON.parse(msg));
			this.partial = "";
		} catch {
			msg = this.partial + msg;
			try {
				this.enqueueObject(JSON.parse(msg));
				this.partial = "";
			} catch {
				this.partial = msg;
			}
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
	// async waitForSkips() {
	// 	await this.ready;
	// }
}

async function sendRetry<T extends Record<string, any>>(
	queue: Queue,
	...args: Parameters<typeof send>
): Promise<{ data: T; error: undefined } | { data: undefined; error: string }> {
	type Err = { error: { message: string } };
	const timeout = setTimeout(() => {
		console.log("Request is taking a while...");
		console.log(
			queue.partial.slice(0, 300) +
				queue.partial.slice(queue.partial.length - 300)
		);
	}, 10000);
	send(...args);
	let data = await queue.dequeueSkip<T | Err>();
	if ("error" in data) {
		await new Promise((res) => setTimeout(res, 200));
		console.log("retry 1");
		send(...args);
		data = await queue.dequeueSkip<T | Err>();
	}
	if ("error" in data) {
		await new Promise((res) => setTimeout(res, 400));
		console.log("retry 2");
		send(...args);
		data = await queue.dequeueSkip<T | Err>();
	}
	if ("error" in data) {
		clearTimeout(timeout);
		return { error: data.error.message, data: undefined };
	}

	clearTimeout(timeout);
	return { data, error: undefined };
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
	// RankingAlgorithm.SimpleTypeIntersection,
	// RankingAlgorithm.SplitTypeIntersection,
	// RankingAlgorithm.StructuredTypeEvaluation,
	// RankingAlgorithm.SelectiveUnification,
	RankingAlgorithm.SelectiveSplitUnification,
];

enum ProofMode {
	Manual = 0,
	Continuous = 1,
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
		process.chdir("..");
		const append = promisify(appendFile);
		const now = new Date().toISOString();
		const csv = await promisify(open)(`out/${now}.csv`, "a");
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
		const scoreCsv = await promisify(open)(`out/scores-${now}.csv`, "a");
		await append(scoreCsv, "File Name;Algorithm;Score;Time\n");
		const testRoot = process.cwd();
		const config: Record<"root" | "files", string>[] = JSON.parse(
			readFileSync("suites.json").toString()
		);
		console.log(JSON.stringify(config, null, 2));
		for (const { files, root } of config) {
			process.chdir(root);
			const thisDir = process.cwd();
			const d = opendirSync(files);
			let next: Dirent | null;
			while ((next = d.readSync())) {
				if (!next.name.endsWith(".v")) {
					continue;
				}
				const file = files + "/" + next.name;
				const uri = "file://" + thisDir + "/" + next.name;
				for (const ranking of rankingAlgortihms) {
					try {
						const { score, time } = await runTest(csv, ranking, file, uri);
						await append(
							scoreCsv,
							`${file};${RankingAlgorithm[ranking]};${score};${time}\n`
						);
					} catch (e) {
						console.log(e);
						console.log("Failed to run test on " + file);
					}
				}
			}
			process.chdir(testRoot);
		}
		await new Promise((res) => (close(csv), close(scoreCsv), res(null)));
	});
	async function runTest(
		csv: PathOrFileDescriptor,
		ranking: RankingAlgorithm,
		file: string,
		uri: string
	) {
		console.log(`Running ${RankingAlgorithm[ranking]} on ${file}...`);

		const startTime = Date.now();

		const coqLibPath = process.env.COQLIB ?? "";

		const vsc = spawn("vscoqtop", ["-bt", "-coqlib", coqLibPath]);

		const queue = await new Promise<Queue>((res) => new Queue(res));

		const decoder = new TextDecoder("utf-8");

		vsc.stdout.on("data", (d) => {
			const decoded = decoder.decode(d).split(/Content-Length: \d+\r?\n\r?\n/);
			decoded.forEach(queue.enqueue);
		});
		vsc.stderr.on("data", (d) => {
			console.error(decoder.decode(d));
		});
		vsc.on("exit", (c) =>
			console.log(
				`vsc exited for ${RankingAlgorithm[ranking]} on ${file}, code ${c}`
			)
		);

		send(vsc, "initialize", {
			processId: process.pid,
			rootUri: "file://" + process.cwd(),
			rootPath: process.cwd(),
			workspaceFolders: [{ uri: process.cwd(), name: "workspace" }],
			capabilities: {},
			initializationOptions: {
				proof: {
					delegation: "None",
					workers: 1,
					mode: ProofMode.Continuous,
				},
				ranking,
			},
		});

		await queue.dequeue(); // initialize
		console.log(JSON.stringify(await queue.dequeue())); // workspace/configuration

		const contents = readFileSync(file, "utf-8");
		const lines = contents.split("\n");

		// editor.setModel()
		model.setValue(contents);

		send(vsc, "textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: "coq",
				text: contents,
			},
		});

		const regex =
			/(apply|rewrite(?: +(?:->|<-))?) ((?:[^\s.,;]\.[^\s.,;]|[^\s.,;])*)/;
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

				search = line.slice(++tacticStart).search(regex);

				// TODO: Determine whether we use word under cursor on backend
				// as completion provider is invoked on every suggest trigger
				await new Promise((res) => setTimeout(res, 100));
				// TODO: Time this
				console.log(`Trying ${_sentence}...`);
				const res = await sendRetry<{ result: { items: [] } }>(
					queue,
					vsc,
					"textDocument/completion",
					{
						textDocument: {
							uri,
						},
						position: { line: i, character: tacticEnd },
					}
				);
				if (res.error !== undefined) {
					console.log(`Got Error in file ${file} with ${_sentence}. Was: ${res.error} `);
					continue;
				}
				console.log(`Got response for ${_sentence}...`);

				completionItems.items = res.data.result.items ?? [];

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
						_completionModel: (typeof controller.model)["_completionModel"];
					};
					const items =
						(controller.model as unknown as Cast)._completionModel?.items ?? [];
					const topTen = items
						.slice(0, TOP_RESULTS)
						.map(({ completion: { insertText } }) => insertText);

					const resultIndex = items.findIndex(
						({ completion: { insertText } }) => insertText === lemma
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

		return { score: S, time: Date.now() - startTime };
	}
});
