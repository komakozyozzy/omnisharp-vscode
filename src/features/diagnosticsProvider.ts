/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import {OmnisharpServer} from '../omnisharp/server';
import AbstractSupport from './abstractProvider';
import * as protocol from '../omnisharp/protocol';
import * as serverUtils from '../omnisharp/utils';
import {toRange} from '../omnisharp/typeConvertion';
import {Disposable, Uri, CancellationTokenSource, TextDocument, Diagnostic, DiagnosticCollection, DiagnosticSeverity, workspace, languages} from 'vscode';

export class Advisor {

    private _disposable: Disposable;
    private _server: OmnisharpServer;
    private _packageRestoreCounter: number = 0;
    private _projectSourceFileCounts: { [path: string]: number } = Object.create(null);

    constructor(server: OmnisharpServer) {
        this._server = server;

        let d1 = server.onProjectChange(this._onProjectChange, this);
        let d2 = server.onProjectAdded(this._onProjectAdded, this);
        let d3 = server.onProjectRemoved(this._onProjectRemoved, this);
        let d4 = server.onBeforePackageRestore(this._onBeforePackageRestore, this);
        let d5 = server.onPackageRestore(this._onPackageRestore, this);
        this._disposable = Disposable.from(d1, d2, d3, d4, d5);
    }

    public dispose() {
        this._disposable.dispose();
    }

    public shouldValidateFiles(): boolean {
        return this._isServerStarted()
            && !this._isRestoringPackages();
    }

    public shouldValidateProject(): boolean {
        return this._isServerStarted()
            && !this._isRestoringPackages()
            && !this._isHugeProject();
    }

    private _updateProjectFileCount(path: string, fileCount: number): void {
        this._projectSourceFileCounts[path] = fileCount;
    }

    private _addOrUpdateProjectFileCount(info: protocol.ProjectInformationResponse): void {
        if (info.DotNetProject && info.DotNetProject.SourceFiles) {
            this._updateProjectFileCount(info.DotNetProject.Path, info.DotNetProject.SourceFiles.length);
        }

        if (info.MsBuildProject && info.MsBuildProject.SourceFiles) {
            this._updateProjectFileCount(info.MsBuildProject.Path, info.MsBuildProject.SourceFiles.length);
        }
    }

    private _removeProjectFileCount(info: protocol.ProjectInformationResponse): void {
        if (info.DotNetProject && info.DotNetProject.SourceFiles) {
            delete this._updateProjectFileCount[info.DotNetProject.Path];
        }

        if (info.MsBuildProject && info.MsBuildProject.SourceFiles) {
            delete this._updateProjectFileCount[info.MsBuildProject.Path];
        }
    }

    private _onProjectAdded(info: protocol.ProjectInformationResponse): void {
        this._addOrUpdateProjectFileCount(info);
    }

    private _onProjectRemoved(info: protocol.ProjectInformationResponse): void {
        this._removeProjectFileCount(info);
    }

    private _onProjectChange(info: protocol.ProjectInformationResponse): void {
        this._addOrUpdateProjectFileCount(info);
    }

    private _onBeforePackageRestore(): void {
        this._packageRestoreCounter += 1;
    }

    private _onPackageRestore(): void {
        this._packageRestoreCounter -= 1;
    }

    private _isRestoringPackages(): boolean {
        return this._packageRestoreCounter > 0;
    }

    private _isServerStarted(): boolean {
        return this._server.isRunning();
    }

    private _isHugeProject(): boolean {
        let sourceFileCount = 0;
        for (let key in this._projectSourceFileCounts) {
            sourceFileCount += this._projectSourceFileCounts[key];
            if (sourceFileCount > 1000) {
                console.log(`_isHugeProject = true (${sourceFileCount})`);
                return true;
            }
        }

        console.log(`_isHugeProject = false (${sourceFileCount})`);
        return false;
    }
}

export default function reportDiagnostics(server: OmnisharpServer, advisor: Advisor): Disposable {
    return new DiagnosticsProvider(server, advisor);
}

class DiagnosticsProvider extends AbstractSupport {

    private _validationAdvisor: Advisor;
    private _disposable: Disposable;
    private _documentValidations: { [uri: string]: CancellationTokenSource } = Object.create(null);
    private _projectValidation: CancellationTokenSource;
    private _diagnostics: DiagnosticCollection;

    constructor(server: OmnisharpServer, validationAdvisor: Advisor) {
        super(server);
        this._validationAdvisor = validationAdvisor;
        this._diagnostics = languages.createDiagnosticCollection('csharp');

        let d1 = this._server.onPackageRestore(this._validateProject, this);
        let d2 = this._server.onProjectChange(this._validateProject, this);
        let d4 = workspace.onDidOpenTextDocument(event => this._onDocumentAddOrChange(event), this);
        let d3 = workspace.onDidChangeTextDocument(event => this._onDocumentAddOrChange(event.document), this);
        let d5 = workspace.onDidCloseTextDocument(this._onDocumentRemove, this);
        this._disposable = Disposable.from(this._diagnostics, d1, d2, d3, d4, d5);
    }

    public dispose(): void {
        if (this._projectValidation) {
            this._projectValidation.dispose();
        }

        for (let key in this._documentValidations) {
            this._documentValidations[key].dispose();
        }

        this._disposable.dispose();
    }

    private _onDocumentAddOrChange(document: TextDocument): void {
        if (document.languageId === 'csharp' && document.uri.scheme === 'file') {
            this._validateDocument(document);
            this._validateProject();
        }
    }

    private _onDocumentRemove(document: TextDocument) {
        let key = document.uri.toString();
        let didChange = false;
        if (this._diagnostics[key]) {
            didChange = true;
            this._diagnostics[key].dispose();
            delete this._diagnostics[key];
        }
        if (this._documentValidations[key]) {
            didChange = true;
            this._documentValidations[key].cancel();
            delete this._documentValidations[key];
        }
        if (didChange) {
            this._validateProject();
        }
    }

    private _validateDocument(document: TextDocument): void {

        // If we've already started computing for this document, cancel that work.
        let key = document.uri.toString();
        if (this._documentValidations[key]) {
            this._documentValidations[key].cancel();
        }

        if (!this._validationAdvisor.shouldValidateFiles()) {
            return;
        }

        let source = new CancellationTokenSource();
        let handle = setTimeout(() => {
            serverUtils.codeCheck(this._server, { Filename: document.fileName }, source.token).then(value => {
                // Easy case: If there are no diagnostics in the file, we can clear it quickly. 
                if (value.QuickFixes.length === 0) {
                    if (this._diagnostics.has(document.uri)) {
                        this._diagnostics.delete(document.uri);
                    }

                    return;
                }
                
                // (re)set new diagnostics for this document
                let diagnostics = value.QuickFixes.map(DiagnosticsProvider._asDiagnostic);

                this._diagnostics.set(document.uri, diagnostics);
            });
        }, 750);

        source.token.onCancellationRequested(() => clearTimeout(handle));
        this._documentValidations[key] = source;
    }

    private _validateProject(): void {
        // If we've already started computing for this project, cancel that work.
        if (this._projectValidation) {
            this._projectValidation.cancel();
        }

        if (!this._validationAdvisor.shouldValidateProject()) {
            return;
        }

        this._projectValidation = new CancellationTokenSource();
        let handle = setTimeout(() => {

            serverUtils.codeCheck(this._server, { Filename: null }, this._projectValidation.token).then(value => {

                let quickFixes = value.QuickFixes.sort((a, b) => a.FileName.localeCompare(b.FileName));
                let entries: [Uri, Diagnostic[]][] = [];
                let lastEntry: [Uri, Diagnostic[]];

                for (let quickFix of quickFixes) {

                    let diag = DiagnosticsProvider._asDiagnostic(quickFix);
                    let uri = Uri.file(quickFix.FileName);

                    if (lastEntry && lastEntry[0].toString() === uri.toString()) {
                        lastEntry[1].push(diag);
                    } else {
                        // We're replacing all diagnostics in this file. Pushing an entry with undefined for
                        // the diagnostics first ensures that the previous diagnostics for this file are
                        // cleared. Otherwise, new entries will be merged with the old ones.
                        entries.push([uri, undefined]);
                        lastEntry = [uri, [diag]];
                        entries.push(lastEntry);
                    }
                }

                // replace all entries
                this._diagnostics.set(entries);
            });
        }, 3000);

        // clear timeout on cancellation
        this._projectValidation.token.onCancellationRequested(() => {
            clearTimeout(handle);
        });
    }

    // --- data converter

    private static _asDiagnostic(quickFix: protocol.QuickFix): Diagnostic {
        let severity = DiagnosticsProvider._asDiagnosticSeverity(quickFix.LogLevel);
        let message = `${quickFix.Text} [${quickFix.Projects.map(n => DiagnosticsProvider._asProjectLabel(n)).join(', ') }]`;
        return new Diagnostic(toRange(quickFix), message, severity);
    }

    private static _asDiagnosticSeverity(logLevel: string): DiagnosticSeverity {
        switch (logLevel.toLowerCase()) {
            case 'warning':
            case 'warn':
                return DiagnosticSeverity.Warning;
            case 'hidden':
                return DiagnosticSeverity.Information;
            default:
                return DiagnosticSeverity.Error;
        }
    }

    private static _asProjectLabel(projectName: string): string {
        const idx = projectName.indexOf('+');
        return projectName.substr(idx + 1);
    }
}
