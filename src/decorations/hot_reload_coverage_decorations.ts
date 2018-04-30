import * as vs from "vscode";
import { DebugCommands } from "../commands/debug";
import { fsPath } from "../utils";

export class HotReloadCoverageDecorations implements vs.Disposable {
	private subscriptions: vs.Disposable[] = [];
	private fileState: {
		[key: string]: {
			modified: CodeRange[],
			notRun: CodeRange[],
		},
	} = {};
	private isDebugging = false;
	private coverageUpdateTimer: NodeJS.Timer;

	// TODO: Move these to gutter
	private readonly modifiedDecorationType = vs.window.createTextEditorDecorationType({
		backgroundColor: "grey",
		rangeBehavior: vs.DecorationRangeBehavior.OpenOpen,
	});
	private readonly notRunDecorationType = vs.window.createTextEditorDecorationType({
		backgroundColor: "red",
		rangeBehavior: vs.DecorationRangeBehavior.OpenOpen,
	});

	constructor(debug: DebugCommands) {
		this.subscriptions.push(vs.workspace.onDidChangeTextDocument((e) => this.onDidChangeTextDocument(e)));
		this.subscriptions.push(vs.window.onDidChangeVisibleTextEditors((e) => this.onDidChangeVisibleTextEditors(e)));
		this.subscriptions.push(debug.onDidHotReload(() => this.onDidHotReload()));
		this.subscriptions.push(debug.onDidFullRestart(() => this.onDidFullRestart()));
		this.subscriptions.push(vs.debug.onDidStartDebugSession((e) => this.onDidStartDebugSession()));
		this.subscriptions.push(vs.debug.onDidTerminateDebugSession((e) => this.onDidTerminateDebugSession()));
		// TODO: On execution, remove from notRun list
		// TODO: If file modified externally, we may need to drop all markers?
	}

	private onDidChangeVisibleTextEditors(editors: vs.TextEditor[]) {
		this.redrawDecorations(editors);
	}

	private onDidChangeTextDocument(e: vs.TextDocumentChangeEvent) {
		if (!this.isDebugging)
			return;

		const editor = vs.window.activeTextEditor.document.uri === e.document.uri ? vs.window.activeTextEditor : null;
		if (!editor)
			return;

		let fileState = this.fileState[fsPath(e.document.uri)];
		if (!fileState) {
			fileState = this.fileState[fsPath(e.document.uri)] = { modified: [], notRun: [] };
		}

		// Update all existing ranges offsets.
		for (const change of e.contentChanges) {
			const diff = change.text.length - change.rangeLength;
			if (diff === 0)
				continue;

			fileState.modified = this.translateChanges(fileState.modified, change);
			fileState.notRun = this.translateChanges(fileState.notRun, change);
		}

		// Append the new ranges.
		for (const change of e.contentChanges) {
			if (change.text.length > 0)
				fileState.modified.push({ offset: change.rangeOffset, length: change.text.length });
		}

		this.redrawDecorations([editor]);
	}

	private translateChanges(ranges: CodeRange[], change: vs.TextDocumentContentChangeEvent): CodeRange[] {
		const diff = change.text.length - change.rangeLength;
		return ranges
			.map((r) => {
				if (change.rangeOffset >= r.offset + r.length) {
					// If the new change is after the old one, we don't need to map.
					return r;
				} else if (change.rangeOffset <= r.offset && change.rangeOffset + change.rangeLength >= r.offset + r.length) {
					// If this new change contains the whole of the old change, we don't need the old change.
					return undefined;
				} else {
					// Otherwise, just need to offset it.
					return { offset: r.offset + diff, length: r.length };
				}
			})
			.filter((r) => r);
	}

	private onDidHotReload(): void {
		for (const file of Object.keys(this.fileState)) {
			for (const line of Object.keys(this.fileState[file]).map((k) => parseInt(k, 10))) {
				const fileState = this.fileState[file];
				fileState.modified.forEach((r) => fileState.notRun.push(r));
				fileState.modified.length = 0;
			}
		}

		this.redrawDecorations(vs.window.visibleTextEditors);
	}

	private onDidFullRestart(): void {
		this.clearAllMarkers();
	}

	private onDidStartDebugSession(): void {
		this.isDebugging = true;
		this.requestCoverageUpdate(true);
	}

	private onDidTerminateDebugSession(): void {
		this.isDebugging = false;
		clearTimeout(this.coverageUpdateTimer);
		this.clearAllMarkers();
	}

	private clearAllMarkers(): void {
		for (const file of Object.keys(this.fileState)) {
			delete this.fileState[file];
		}

		this.redrawDecorations(vs.window.visibleTextEditors);
	}

	private redrawDecorations(editors: vs.TextEditor[]): void {
		if (!editors)
			return;
		for (const editor of editors) {
			const fileState = this.fileState[fsPath(editor.document.uri)];
			editor.setDecorations(
				this.modifiedDecorationType,
				fileState ? this.toRanges(editor, fileState.modified) : [],
			);
			editor.setDecorations(
				this.notRunDecorationType,
				fileState ? this.toRanges(editor, fileState.notRun) : [],
			);
		}
	}

	private toRanges(editor: vs.TextEditor, rs: CodeRange[]): vs.Range[] {
		return rs.map((r) => new vs.Range(editor.document.positionAt(r.offset), editor.document.positionAt(r.offset + r.length)));
	}

	private async requestCoverageUpdate(skip: boolean = false): Promise<void> {
		const hasAnyChanges = !!Object.keys(this.fileState)
			.find((file) => this.fileState[file].notRun.length !== 0);
		if (hasAnyChanges && !skip) {
			await vs.commands.executeCommand(
				"_dart.updateCoverage",
				vs.window.visibleTextEditors.map((e) => fsPath(e.document.uri)),
			);
		}

		// TODO: Don't do on timer!
		// TODO: Don't do if already in progress?
		this.coverageUpdateTimer = setTimeout(() => this.requestCoverageUpdate(), 10000);
	}

	public dispose() {
		this.subscriptions.forEach((s) => s.dispose());
	}
}

interface CodeRange {
	offset: number;
	length: number;
}