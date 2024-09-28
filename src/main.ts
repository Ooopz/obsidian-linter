import {App, Editor, EventRef, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, addIcon, htmlToMarkdown, EditorSelection, EditorChange, normalizePath, MarkdownFileInfo, debounce, Debouncer} from 'obsidian';
import {Options, RuleType, ruleTypeToRules, rules} from './rules';
import DiffMatchPatch from 'diff-match-patch';
import dedent from 'ts-dedent';
import {parseCustomReplacements, stripCr} from './utils/strings';
import {logInfo, logError, logDebug, setLogLevel, logWarn, setCollectLogs, clearLogs, convertNumberToLogLevel} from './utils/logger';
import {moment} from 'obsidian';
import './rules-registry';
import {iconInfo} from './ui/icons';
import {createRunLinterRulesOptions, RulesRunner} from './rules-runner';
import {LinterError} from './linter-error';
import {LintConfirmationModal} from './ui/modals/lint-confirmation-modal';
import {SettingTab} from './ui/settings';
import {urlRegex} from './utils/regex';
import {getTextInLanguage, LanguageStringKey, setLanguage} from './lang/helpers';
import {RuleAliasSuggest} from './cm6/rule-alias-suggester';
import {AfterFileChangeLintTimes, DEFAULT_SETTINGS, LinterSettings} from './settings-data';
import AsyncLock from 'async-lock';
import {warn} from 'loglevel';
import {CustomAutoCorrectContent} from './ui/linter-components/auto-correct-files-picker-option';
import {ChangeSpec} from '@codemirror/state';

// https://github.com/liamcain/obsidian-calendar-ui/blob/03ceecbf6d88ef260dadf223ee5e483d98d24ffc/src/localization.ts#L20-L43
const langToMomentLocale = {
  'en': 'en-gb',
  'zh': 'zh-cn',
  'zh-TW': 'zh-tw',
  'ru': 'ru',
  'ko': 'ko',
  'it': 'it',
  'id': 'id',
  'ro': 'ro',
  'pt-BR': 'pt-br',
  'cz': 'cs',
  'da': 'da',
  'de': 'de',
  'es': 'es',
  'fr': 'fr',
  'no': 'nn',
  'pl': 'pl',
  'pt': 'pt',
  'tr': 'tr',
  'hi': 'hi',
  'nl': 'nl',
  'ar': 'ar',
  'ja': 'ja',
};

const userClickTimeout = 0;

type FileChangeUpdateInfo = {
  debounceFn: Debouncer<[TFile, Editor], Promise<void>>,
  isRunning: boolean
  originalText: string
}

export default class LinterPlugin extends Plugin {
  settings: LinterSettings;
  settingsTab: SettingTab;
  private eventRefs: EventRef[] = [];
  private momentLocale: string;
  private isEnabled: boolean = true;
  private rulesRunner = new RulesRunner();
  private lastActiveFile: TFile;
  private overridePaste: boolean = false;
  private hasCustomCommands: boolean = false;
  private hasLoadedFiles: boolean = false;
  private customCommandsLock = new AsyncLock();
  private originalSaveCallback?: () => void = null;
  // The amount of files you can use editor lint on at once is pretty small, so we will use an array
  private editorLintFiles: TFile[] = [];
  // the amount of files that can be linted as a file can be quite large, so we will want to use a set to make
  // search and other operations faster
  private fileLintFiles: Set<TFile> = new Set();
  private customCommandsCallback: (file: TFile) => Promise<void> = null;
  private currentlyOpeningSidebar: boolean = false;
  private activeFileChangeDebouncer: Map<TFile, FileChangeUpdateInfo> = new Map();

  async onload() {
    setLanguage(window.localStorage.getItem('language'));
    logInfo(getTextInLanguage('logs.plugin-load'));

    this.isEnabled = true;
    // eslint-disable-next-line guard-for-in
    for (const key in iconInfo) {
      const svg = iconInfo[key];
      addIcon(svg.id, svg.source);
    }

    await this.loadSettings();

    this.addCommands();

    this.registerEventsAndSaveCallback();

    this.registerEditorSuggest(new RuleAliasSuggest(this));

    this.settingsTab = new SettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
  }

  async onunload() {
    logInfo(getTextInLanguage('logs.plugin-unload'));
    this.isEnabled = false;

    for (const eventRef of this.eventRefs) {
      this.app.workspace.offref(eventRef);
    }

    const saveCommandDefinition = this.app.commands?.commands?.[
      'editor:save-file'
    ];
    if (saveCommandDefinition && saveCommandDefinition.callback && this.originalSaveCallback) {
      saveCommandDefinition.callback = this.originalSaveCallback;
    }
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (typeof this.settings.logLevel === 'number') {
      this.settings.logLevel = convertNumberToLogLevel(this.settings.logLevel);
    }

    setLogLevel(this.settings.logLevel);
    await this.setOrUpdateMomentInstance();

    if (!this.settings.settingsConvertedToConfigKeyValues) {
      this.moveConfigValuesToKeyBasedFormat();
    }

    // make sure to load the defaults of any missing rules to make sure they do not cause issues on the settings page
    for (const rule of rules) {
      if (!this.settings.ruleConfigs[rule.alias]) {
        this.settings.ruleConfigs[rule.alias] = rule.getDefaultOptions();
      }

      // remove this after a reasonable amount of time
      if (rule.alias == 'space-between-chinese-japanese-or-korean-and-english-or-numbers') {
        const defaults = rule.getDefaultOptions();
        if (!('english-symbols-punctuation-before' in this.settings.ruleConfigs[rule.alias])) {
          this.settings.ruleConfigs[rule.alias]['english-symbols-punctuation-before'] = defaults['english-symbols-punctuation-before'];
        }

        if (!('english-symbols-punctuation-after' in this.settings.ruleConfigs[rule.alias])) {
          this.settings.ruleConfigs[rule.alias]['english-symbols-punctuation-after'] = defaults['english-symbols-punctuation-after'];
        }
      }
      // TODO: add logic for moving force retention pjk
    }

    this.updatePasteOverrideStatus();
    this.updateHasCustomCommandStatus();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.updatePasteOverrideStatus();
    this.updateHasCustomCommandStatus();
  }

  addCommands() {
    const that = this;
    this.addCommand({
      id: 'lint-file',
      name: getTextInLanguage('commands.lint-file.name'),
      editorCheckCallback(checking, editor, ctx) {
        if (checking) {
          return that.isMarkdownFile(ctx.file) && editor.cm != null;
        }

        void that.runLinterEditor(editor);
      },
      icon: iconInfo.file.id,
      hotkeys: [
        {
          modifiers: ['Mod', 'Alt'],
          key: 'L',
        },
      ],
    });

    this.addCommand({
      id: 'lint-file-unless-ignored',
      name: getTextInLanguage('commands.lint-file-unless-ignored.name'),
      editorCheckCallback(checking, editor, ctx) {
        if (checking) {
          return that.isMarkdownFile(ctx.file);
        }

        if (!that.shouldIgnoreFile(ctx.file) && editor.cm) {
          void that.runLinterEditor(editor);
        }
      },
      icon: iconInfo.file.id,
    });

    this.addCommand({
      id: 'lint-all-files',
      name: getTextInLanguage('commands.lint-all-files.name'),
      icon: iconInfo.vault.id,
      callback: () => {
        const startMessage = getTextInLanguage('commands.lint-all-files.start-message');
        const submitBtnText = getTextInLanguage('commands.lint-all-files.submit-button-text');
        const submitBtnNoticeText = getTextInLanguage('commands.lint-all-files.submit-button-notice-text');
        new LintConfirmationModal(this.app, startMessage, submitBtnText, submitBtnNoticeText, () => {
          return this.runLinterAllFiles(this.app);
        }, this.settings.lintCommands && this.settings.lintCommands.length > 0).open();
      },
    });

    this.addCommand({
      id: 'lint-all-files-in-folder',
      name: getTextInLanguage('commands.lint-all-files-in-folder.name'),
      icon: iconInfo.folder.id,
      editorCheckCallback: (checking: Boolean, _, ctx) => {
        if (checking) {
          return !ctx.file.parent.isRoot();
        }

        this.createFolderLintModal(ctx.file.parent);
      },
    });

    this.addCommand({
      id: 'paste-as-plain-text',
      name: getTextInLanguage('commands.paste-as-plain-text.name'),
      editorCheckCallback: (checking, editor) => {
        if (checking) {
          return this.overridePaste;
        }

        void this.pasteAsPlainText(editor);
      },
    });
  }

  registerEventsAndSaveCallback() {
    let eventRef = this.app.workspace.on('editor-paste', (clipboardEv: ClipboardEvent) => {
      // do not paste if another handler has already handled pasting text as that would likely cause a
      // double pasting of the clipboard contents
      // also skip if no paste rules are enabled
      if (clipboardEv.defaultPrevented || !this.overridePaste) {
        return;
      }

      void this.modifyPasteEvent(clipboardEv);
    });
    this.registerEvent(eventRef);
    this.eventRefs.push(eventRef);

    eventRef = this.app.workspace.on('file-menu', (menu, file, source) => this.onMenuOpenCallback(menu, file, source));
    this.registerEvent(eventRef);
    this.eventRefs.push(eventRef);

    this.lastActiveFile = this.app.workspace.getActiveFile();
    eventRef = this.app.workspace.on('active-leaf-change', () => this.onActiveLeafChange());
    this.registerEvent(eventRef);
    this.eventRefs.push(eventRef);

    eventRef = this.app.metadataCache.on('changed', (file: TFile) => this.onMetadataCacheUpdatedCallback(file));
    this.registerEvent(eventRef);
    this.eventRefs.push(eventRef);

    eventRef = this.app.workspace.on('editor-change', async (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
      if (this.settings.lintOnFileContentChangeDelay == AfterFileChangeLintTimes.Never) {
        return;
      }

      if (this.shouldIgnoreFile(info.file) || !this.isMarkdownFile(info.file) || !editor.cm) {
        return;
      }

      if (this.activeFileChangeDebouncer.has(info.file)) {
        const activeFileChangeInfo = this.activeFileChangeDebouncer.get(info.file);
        if (!activeFileChangeInfo.isRunning) {
          this.activeFileChangeDebouncer.get(info.file).debounceFn(info.file, editor);
        }
      } else {
        this.activeFileChangeDebouncer.set(info.file, {
          debounceFn: this.createDebouncedFileUpdate(),
          isRunning: false,
          originalText: editor.getValue(),
        });
      }
    });
    this.registerEvent(eventRef);
    this.eventRefs.push(eventRef);

    // Source for save setting
    // https://github.com/hipstersmoothie/obsidian-plugin-prettier/blob/main/src/main.ts
    const saveCommandDefinition = this.app.commands?.commands?.[
      'editor:save-file'
    ];

    this.originalSaveCallback = saveCommandDefinition?.callback;

    if (typeof this.originalSaveCallback === 'function') {
      saveCommandDefinition.callback = () => {
        this.originalSaveCallback();

        if (this.settings.lintOnSave && this.isEnabled) {
          const editor = this.getEditor();
          if (editor) {
            const file = this.app.workspace.getActiveFile();
            if (!this.shouldIgnoreFile(file) && this.isMarkdownFile(file) && editor.cm) {
              void this.runLinterEditor(editor);
            }
          }
        }
      };
    }

    // defines the vim command for saving a file and lets the linter run on save for it
    // accounts for https://github.com/platers/obsidian-linter/issues/19
    const that = this;
    window.CodeMirrorAdapter.commands.save = () => {
      that.app.commands.executeCommandById('editor:save-file');
    };
  }

  async onMetadataCacheUpdatedCallback(file: TFile) {
    if (this.editorLintFiles.includes(file)) {
      this.editorLintFiles.remove(file);

      void this.runCustomCommands(file);
    } else if (this.fileLintFiles.has(file)) {
      this.fileLintFiles.delete(file);

      void this.runCustomCommandsInSidebar(file);
    }
  }

  onMenuOpenCallback(menu: Menu, file: TAbstractFile, _source: string) {
    if (file instanceof TFile && this.isMarkdownFile(file)) {
      menu.addItem((item) => {
        item.setIcon(iconInfo.file.id)
            .setTitle(getTextInLanguage('commands.lint-file-pop-up-menu-text.name'))
            .onClick(() => {
              const activeFile = this.app.workspace.getActiveFile();
              const editor = this.getEditor();
              if (activeFile === file && editor && editor.cm) {
                void this.runLinterEditor(editor);
              } else {
                void this.runLinterFile(file);
              }
            });
      });
    } else if (file instanceof TFolder) {
      menu.addItem((item) => {
        item
            .setTitle(getTextInLanguage('commands.lint-folder-pop-up-menu-text.name'))
            .setIcon(iconInfo.folder.id)
            .onClick(() => this.createFolderLintModal(file));
      });
    }
  }

  async onActiveLeafChange() {
    if (!this.isEnabled || this.currentlyOpeningSidebar) {
      return;
    }

    const currentActiveFile = this.app.workspace.getActiveFile();
    const lastActiveFileExists = this.lastActiveFile == null ? false : await this.app.vault.adapter.exists(this.lastActiveFile.path);
    if (!this.settings.lintOnFileChange || !lastActiveFileExists || this.lastActiveFile === currentActiveFile || !this.isMarkdownFile(this.lastActiveFile) || this.shouldIgnoreFile(this.lastActiveFile)) {
      this.lastActiveFile = currentActiveFile;
      return;
    }

    try {
      await this.runLinterFile(this.lastActiveFile, true);
    } catch (error) {
      this.handleLintError(this.lastActiveFile, error, getTextInLanguage('commands.lint-file.error-message') + ' \'{FILE_PATH}\'', false);
    } finally {
      this.lastActiveFile = currentActiveFile;
    }
  }

  shouldIgnoreFile(file: TFile): boolean {
    for (const folder of this.settings.foldersToIgnore) {
      if (folder.length > 0 && file.path.startsWith(folder)) {
        return true;
      }
    }

    for (const fileToIgnore of this.settings.filesToIgnore) {
      if (!fileToIgnore.match) {
        continue;
      }

      const fileNameRegex = new RegExp(`${fileToIgnore.match}`, fileToIgnore.flags);
      if (fileNameRegex.test(file.path)) {
        return true;
      }
    }

    return false;
  }

  isMarkdownFile(file: TFile): boolean {
    return file && file.extension === 'md';
  }

  async runLinterFile(file: TFile, lintingLastActiveFile: boolean = false) {
    if (!this.hasLoadedFiles) {
      await this.loadCustomReplacements();
    }

    const oldText = stripCr(await this.app.vault.read(file));
    const newText = this.rulesRunner.lintText(createRunLinterRulesOptions(oldText, file, this.momentLocale, this.settings));

    if (oldText != newText) {
      await this.app.vault.modify(file, newText);

      if (lintingLastActiveFile) {
        const message = getTextInLanguage('logs.file-change-lint-message-start') + ' ' + this.lastActiveFile.path;
        if (this.settings.displayLintOnFileChangeNotice) {
          new Notice(message);
        }

        logInfo(message);
      }

      // when a change is made to the file we know that the cache will update down the road
      // so we can defer running the custom commands to the cache callback
      this.fileLintFiles.add(file);

      return;
    }

    await this.runCustomCommandsInSidebar(file);
  }

  async runLinterAllFiles(app: App) {
    let numberOfErrors = 0;
    await Promise.all(app.vault.getMarkdownFiles().map(async (file) => {
      if (!this.shouldIgnoreFile(file)) {
        try {
          await this.runLinterFile(file);
        } catch (error) {
          this.handleLintError(file, error, getTextInLanguage('commands.lint-all-files.error-message') + ' \'{FILE_PATH}\'');

          numberOfErrors += 1;
        }
      }
    }));

    if (numberOfErrors === 0) {
      new Notice(getTextInLanguage('commands.lint-all-files.success-message'), userClickTimeout);
    } else {
      const errorMessage = numberOfErrors === 1 ? getTextInLanguage('commands.lint-all-files.errors-message-singular') : getTextInLanguage('commands.lint-all-files.errors-message-plural').replace('{NUM}', numberOfErrors.toString());
      new Notice(errorMessage, userClickTimeout);
    }
  }

  async runLinterAllFilesInFolder(folder: TFolder) {
    logInfo(getTextInLanguage('logs.folder-lint') + folder.name);

    let numberOfErrors = 0;
    let lintedFiles = 0;
    const filesInFolder = this.getAllFilesInFolder(folder);
    await Promise.all(filesInFolder.map(async (file) => {
      if (!this.shouldIgnoreFile(file)) {
        try {
          await this.runLinterFile(file);
        } catch (error) {
          this.handleLintError(file, error, getTextInLanguage('commands.lint-all-files-in-folder.error-message') + ' \'{FILE_PATH}\'');

          numberOfErrors += 1;
        }

        lintedFiles++;
      }
    }));

    if (numberOfErrors === 0) {
      new Notice(getTextInLanguage('commands.lint-all-files-in-folder.success-message').replace('{NUM}', lintedFiles.toString()).replace('{FOLDER_NAME}', folder.name), userClickTimeout);
    } else {
      const errorMessageText = numberOfErrors === 1 ? getTextInLanguage('commands.lint-all-files-in-folder.message-singular').replace('{NUM}', lintedFiles.toString()).replace('{FOLDER_NAME}', folder.name):
      getTextInLanguage('commands.lint-all-files-in-folder.message-plural').replace('{FILE_COUNT}', lintedFiles.toString()).replace('{FOLDER_NAME}', folder.name).replace('{ERROR_COUNT}', numberOfErrors.toString());
      new Notice(errorMessageText, userClickTimeout);
    }
  }

  // handles the creation of the folder linting modal since this happens in multiple places and it should be consistent
  createFolderLintModal(folder: TFolder) {
    const startMessage = getTextInLanguage('commands.lint-all-files-in-folder.start-message').replace('{FOLDER_NAME}', folder.name);
    const submitBtnText = getTextInLanguage('commands.lint-all-files-in-folder.submit-button-text').replace('{FOLDER_NAME}', folder.name);
    const submitBtnNoticeText = getTextInLanguage('commands.lint-all-files-in-folder.submit-button-notice-text').replace('{FOLDER_NAME}', folder.name);
    new LintConfirmationModal(this.app, startMessage, submitBtnText, submitBtnNoticeText, () => this.runLinterAllFilesInFolder(folder), this.settings.lintCommands && this.settings.lintCommands.length > 0).open();
  }

  async runLinterEditor(editor: Editor) {
    setCollectLogs(this.settings.recordLintOnSaveLogs);
    clearLogs();

    logInfo(getTextInLanguage('logs.linter-run'));

    if (!this.hasLoadedFiles) {
      await this.loadCustomReplacements();
    }

    const file = this.app.workspace.getActiveFile();
    const oldText = editor.getValue();
    let newText: string;
    try {
      newText = this.rulesRunner.lintText(createRunLinterRulesOptions(oldText, file, this.momentLocale, this.settings));
    } catch (error) {
      this.handleLintError(file, error, getTextInLanguage('commands.lint-file.error-message') + ' \'{FILE_PATH}\'', false);
      return;
    }

    const changes = this.updateEditor(oldText, newText, editor);
    const charsAdded = changes.map((change) => change[0] == DiffMatchPatch.DIFF_INSERT ? change[1].length : 0).reduce((a, b) => a + b, 0);
    const charsRemoved = changes.map((change) => change[0] == DiffMatchPatch.DIFF_DELETE ? change[1].length : 0).reduce((a, b) => a + b, 0);

    this.displayChangedMessage(charsAdded, charsRemoved);

    // run custom commands now since no change was made
    if (!charsAdded && !charsRemoved) {
      void this.runCustomCommands(file);
    } else {
      this.editorLintFiles.push(file);
    }

    this.updateFileDebouncerText(file, newText);

    setCollectLogs(false);
  }

  // based on https://github.com/liamcain/obsidian-calendar-ui/blob/03ceecbf6d88ef260dadf223ee5e483d98d24ffc/src/localization.ts#L85-L109
  async setOrUpdateMomentInstance() {
    const obsidianLang: string = localStorage.getItem('language') || 'en';
    const systemLang = navigator.language?.toLowerCase();

    let momentLocale = langToMomentLocale[obsidianLang as keyof typeof langToMomentLocale];

    if (this.settings.linterLocale !== 'system-default') {
      momentLocale = this.settings.linterLocale;
    } else if (systemLang.startsWith(obsidianLang)) {
      // If the system locale is more specific (en-gb vs en), use the system locale.
      momentLocale = systemLang;
    }

    this.momentLocale = momentLocale;
    const oldLocale = moment.locale();
    const currentLocale = moment.locale(momentLocale);
    logDebug(getTextInLanguage('logs.moment-locale-not-found').replace('{MOMENT_LOCALE}', momentLocale).replace('{CURRENT_LOCALE}', currentLocale));

    moment.locale(oldLocale);
  }

  private createDebouncedFileUpdate(): Debouncer<[TFile, Editor], Promise<void>> {
    let delay = 5000;
    switch (this.settings.lintOnFileContentChangeDelay) {
      case AfterFileChangeLintTimes.After10Seconds:
        delay = 10000;
        break;
      case AfterFileChangeLintTimes.After15Seconds:
        delay = 15000;
        break;
      case AfterFileChangeLintTimes.After30Seconds:
        delay = 30000;
        break;
      case AfterFileChangeLintTimes.After1Minute:
        delay = 60000;
        break;
    }

    return debounce(
        async (file: TFile, editor: Editor) => {
          if (!this.activeFileChangeDebouncer.has(file)) {
            logWarn(getTextInLanguage('logs.file-change-yaml-lint-warning'));
            return;
          }

          const activeFileChangeInfo = this.activeFileChangeDebouncer.get(file);
          activeFileChangeInfo.isRunning = true;

          const oldText = editor.getValue();
          let newText = oldText;
          if (oldText != activeFileChangeInfo.originalText ) {
            logInfo(getTextInLanguage('logs.file-change-yaml-lint-run'));
            try {
              newText = this.rulesRunner.runYAMLTimestampByItself(createRunLinterRulesOptions(oldText, file, this.momentLocale, this.settings));
            } catch (error) {
              this.handleLintError(file, error, getTextInLanguage('commands.lint-file.error-message') + ' \'{FILE_PATH}\'', false);
              return;
            }

            this.updateEditor(oldText, newText, editor);
          } else {
            logInfo(getTextInLanguage('logs.file-change-yaml-lint-skipped'));
          }

          activeFileChangeInfo.isRunning = false;
          // update text value just in case we retain this and are forced to run another update. It will help weed out other changes.
          activeFileChangeInfo.originalText = newText;

          // retain active file debounce info, but all others should be safe to remove
          const activeFile = this.app.workspace.getActiveFile();
          if (!activeFile || activeFile != file) {
            this.activeFileChangeDebouncer.delete(file);
          }
        },
        delay,
        true,
    );
  }

  private updateEditor(oldText: string, newText: string, editor: Editor): DiffMatchPatch.Diff[] {
    const dmp = new DiffMatchPatch.diff_match_patch(); // eslint-disable-line new-cap
    const changes = dmp.diff_main(oldText, newText);
    let curText = '';
    changes.forEach((change) => {
      const [type, value] = change;

      if (type == DiffMatchPatch.DIFF_INSERT) {
        // use codemirror dispatch in order to bypass the filter on transactions that causes editor.replaceRange not to not work in Live Preview
        editor.cm.dispatch({
          changes: [{
            from: editor.posToOffset(this.endOfDocument(curText)),
            insert: value,
          } as ChangeSpec],
          filter: false,
        });
        curText += value;
      } else if (type == DiffMatchPatch.DIFF_DELETE) {
        const start = this.endOfDocument(curText);
        let tempText = curText;
        tempText += value;
        const end = this.endOfDocument(tempText);

        // use codemirror dispatch in order to bypass the filter on transactions that causes editor.replaceRange not to not work in Live Preview
        editor.cm.dispatch({
          changes: [{
            from: editor.posToOffset(start),
            to: editor.posToOffset(end),
            insert: '',
          } as ChangeSpec],
          filter: false,
        });
      } else {
        curText += value;
      }
    });

    return changes;
  }

  private displayChangedMessage(charsAdded: number, charsRemoved: number) {
    if (this.settings.displayChanged) {
      const message = dedent`
        ${charsAdded} ${getTextInLanguage('notice-text.characters-added')}
        ${charsRemoved} ${getTextInLanguage('notice-text.characters-removed')}
      `;
      new Notice(message);
    }
  }

  private handleLintError(file: TFile, error: Error, logErrorStringTemplate: string, useLogTemplateInNotice: boolean = true) {
    const errorMessage = logErrorStringTemplate.replace('{FILE_PATH}', file.path);
    const seeConsoleText = getTextInLanguage('logs.see-console');

    if (error instanceof LinterError) {
      if (useLogTemplateInNotice) {
        new Notice(`${errorMessage} ${error.message}.\n${seeConsoleText}`, userClickTimeout);
      } else {
        new Notice(`${error.message}.\n${seeConsoleText}`, userClickTimeout);
      }
    } else {
      new Notice(`${getTextInLanguage('logs.unknown-error')} ${seeConsoleText}`, userClickTimeout);
    }

    logError(errorMessage, error);
  }

  // based on https://github.com/chrisgrieser/obsidian-smarter-paste/blob/master/main.ts#L43-L79
  // INFO: to inspect clipboard content types, use https://evercoder.github.io/clipboard-inspector/
  async modifyPasteEvent(clipboardEv: ClipboardEvent): Promise<void> {
    // abort when pane isn't markdown editor
    const editor = this.getEditor();
    if (!editor) return;
    // abort when clipboard contains an image (or is empty)
    // check for plain text, since 'getData("text/html")' ignores plain-text
    const plainClipboard = clipboardEv.clipboardData.getData('text/plain');
    if (!plainClipboard) return;

    // Abort when clipboard has URL, to prevent conflict with the plugins
    // Auto Title Link & Paste URL into Selection
    // because otherwise having 2 URLs cause Obsidian-breaking conflict.
    // Note: it looks like those two plugins look for an exact match for a URL,
    // so we will too.
    const text = plainClipboard.trim();
    if (urlRegex.test(text)) {
      logWarn(getTextInLanguage('logs.paste-link-warning'));
      return;
    }

    // prevent default pasting & abort when not successful
    clipboardEv.stopPropagation();
    clipboardEv.preventDefault();
    if (!clipboardEv.defaultPrevented) return;

    // use Turndown via Obsidian API to emulate "Auto Convert HTML" setting
    const convertHtmlEnabled = this.app.vault.getConfig('autoConvertHtml');
    const htmlClipText = clipboardEv.clipboardData.getData('text/html');
    let clipboardText = htmlClipText && convertHtmlEnabled ? htmlToMarkdown(htmlClipText) : plainClipboard;

    // if everything went well, run clipboard modifications (passing in current line and text to paste)
    const cursorSelections = editor.listSelections();
    if (cursorSelections.length === 1) {
      const cursorSelection = cursorSelections[0];
      clipboardText = this.rulesRunner.runPasteLint(this.getLineContent(editor, cursorSelection),
          editor.getSelection() ?? '',
          createRunLinterRulesOptions(clipboardText, null, this.momentLocale, this.settings),
      );

      editor.replaceSelection(clipboardText);
    } else {
      this.handleMultiCursorPaste(editor, cursorSelections, clipboardText);
    }
  }

  /**
   * Goes ahead and makes sure that each cursor has the proper paste value and only gets that text pasted there instead of at each cursor.
   * @param {Editor} editor - The codemirror editor where the content is located.
   * @param {EditorSelection[]} cursorSelections - The cursor selections made by the user.
   * @param {string} clipboardText - The clipboard text that is to be pasted, but first needs to be converted to the proper paste value for each cursor.
   */
  handleMultiCursorPaste(editor: Editor, cursorSelections: EditorSelection[], clipboardText: string) {
    const pasteContentPerCursor = this.convertContentIntoProperPasteContent(cursorSelections, clipboardText);
    const editorChange: EditorChange[] = [];

    cursorSelections.forEach((cursorSelection: EditorSelection, index: number) => {
      clipboardText = this.rulesRunner.runPasteLint(this.getLineContent(editor, cursorSelection), editor.getRange(cursorSelection.anchor, cursorSelection.head) ?? '', createRunLinterRulesOptions(pasteContentPerCursor[index], null, this.momentLocale, this.settings));
      editorChange.push({
        text: clipboardText,
        from: cursorSelection.anchor,
        to: cursorSelection.head,
      });
    });

    // make sure that they are considered one change so that undo will only need to happen once for a multicursor paste
    editor.transaction({
      changes: editorChange,
    });
  }

  /**
   * Divvies up the clipboard text between the multiple cursors and makes sure they either have the whole clipboard text or an even amount of lines from the the clipboard text.
   * @param {EditorSelection[]} cursorSelections - The cursor selections made by the user.
   * @param {string} clipboardText - The clipboard text that is to be pasted, but first needs to be converted to the proper paste value for each cursor.
   * @return {string[]} The content to paste at each cursor which is either the clipboard text or an even division of the clipboard text if there is a multiple
   * of the amount of cursors that is equal to the amount of lines clipboard text.
   */
  convertContentIntoProperPasteContent(cursorSelections: EditorSelection[], clipboardText: string): string[] {
    const clipboardLines = clipboardText.split('\n');
    const contentToPasteForEachCursor: string[] = [];
    if (clipboardLines.length % cursorSelections.length !== 0) {
      for (let index = 0; index < cursorSelections.length; index++) {
        contentToPasteForEachCursor.push(clipboardText);
      }
    } else {
      const numberOfLinesPerCursorSelection = clipboardLines.length / cursorSelections.length;
      let contentToPasteForCursorSelection = '';
      for (let index = 0; index < clipboardLines.length; index++) {
        contentToPasteForCursorSelection += clipboardLines[index];

        // if we are the last index or if the next index should start the next cursor selection paste content, add the cursor selection content to its proper location
        if (index + 1 === cursorSelections.length || ((index + 1) % numberOfLinesPerCursorSelection === 0)) {
          contentToPasteForEachCursor.push(contentToPasteForCursorSelection);
          contentToPasteForCursorSelection = '';
        }
      }
    }

    return contentToPasteForEachCursor;
  }

  async pasteAsPlainText(editor: Editor): Promise<void> {
    const clipboardContent = await navigator.clipboard.readText();
    if (!clipboardContent) {
      new Notice(getTextInLanguage('notice-text.empty-clipboard'), userClickTimeout);
      return;
    }

    editor.replaceSelection(clipboardContent);
  }

  setCustomCommandCallback(callback: (file: TFile) => Promise<void>) {
    warn(getTextInLanguage('logs.custom-command-callback-warning'));
    this.customCommandsCallback = callback;
  }

  private async runCustomCommandsInSidebar(file: TFile) {
    if (!this.settings.lintCommands || this.settings.lintCommands.length == 0 || !this.hasCustomCommands) {
      return;
    }

    const sidebarTab = this.app.workspace.getRightLeaf(false);
    const activeEditor = this.getEditor();

    await this.customCommandsLock.acquire('command', async () => {
      this.currentlyOpeningSidebar = true;

      await sidebarTab.openFile(file);
      this.rulesRunner.runCustomCommands(this.settings.lintCommands, this.app.commands);
      if (this.customCommandsCallback) {
        await this.customCommandsCallback(file);
      }
    });
    sidebarTab.detach();
    if (activeEditor) {
      activeEditor.focus();
    }

    this.currentlyOpeningSidebar = false;
  }

  private async runCustomCommands(file: TFile) {
    if (!this.settings.lintCommands || this.settings.lintCommands.length == 0 || !this.hasCustomCommands) {
      return;
    }

    await this.customCommandsLock.acquire('command', async () => {
      try {
        this.rulesRunner.runCustomCommands(this.settings.lintCommands, this.app.commands);
      } catch (error) {
        this.handleLintError(file, error, getTextInLanguage('commands.lint-file.error-message') + ' \'{FILE_PATH}\'', false);
      }

      if (this.customCommandsCallback) {
        await this.customCommandsCallback(file);
      }
    });

    this.updateFileDebouncerText(file, stripCr(await this.app.vault.read(file)));
  }

  /**
   * Gets the current markdown editor if it exists {@link https://github.com/chrisgrieser/obsidian-smarter-paste/blob/master/main.ts#L37-L41|Obsidian Smarter Paste Source}
   * @return {Editor} Returns the current codemirror editor if there is an active view of type markdown or null if there is not one.
   */
  private getEditor(): Editor {
    const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeLeaf) return null;
    return activeLeaf.editor;
  }

  /**
   * Makes sure to get the whole line where the cursor is at even if a selection is made.
   * @param {Editor} editor - The codemirror editor where the content is located.
   * @param {EditorSelection} selection - The codemirror editor selection where a cursor is at.
   * @return {string} The current line contents in the editor (i.e. the line where the cursor is)
   */
  private getLineContent(editor:Editor, selection: EditorSelection): string {
    return editor.getLine(selection.anchor.line);
  }

  private moveConfigValuesToKeyBasedFormat() {
    setLanguage('en');

    for (const rule of rules) {
      const ruleName = getTextInLanguage('rules.' + rule.alias + '.name' as LanguageStringKey);
      const ruleSettings = this.settings.ruleConfigs[ruleName];
      if (ruleSettings != undefined) {
        const ruleDescription = getTextInLanguage('rules.' + rule.alias + '.description' as LanguageStringKey);
        // move description config value to new setting location
        const newSettingValues: Options = {
          enabled: ruleSettings[ruleDescription] ?? false,
        };

        // move option config values to new setting location
        for (const option of rule.options) {
          // skip the description of the setting
          if (option.configKey === 'enabled') {
            continue;
          }

          const configKeyName = getTextInLanguage('rules.' + rule.alias + '.' + option.configKey + '.name' as LanguageStringKey);
          newSettingValues[option.configKey] = ruleSettings[configKeyName] ?? option.defaultValue;
        }

        this.settings.ruleConfigs[rule.alias] = newSettingValues;
        delete this.settings.ruleConfigs[ruleName];
      }
    }

    this.settings.settingsConvertedToConfigKeyValues = true;
    void this.saveSettings();

    setLanguage(window.localStorage.getItem('language'));
  }

  private getAllFilesInFolder(startingFolder: TFolder): TFile[] {
    const filesInFolder = [] as TFile[];
    const foldersToIterateOver = [startingFolder] as TFolder[];
    for (const folder of foldersToIterateOver) {
      for (const child of folder.children) {
        if (child instanceof TFile && this.isMarkdownFile(child)) {
          filesInFolder.push(child);
        } else if (child instanceof TFolder) {
          foldersToIterateOver.push(child);
        }
      }
    }

    return filesInFolder;
  }

  private updatePasteOverrideStatus() {
    for (const rule of ruleTypeToRules.get(RuleType.PASTE)) {
      if (rule.getOptions(this.settings)['enabled']) {
        this.overridePaste = true;
        return;
      }
    }

    this.overridePaste = false;
  }

  private updateHasCustomCommandStatus() {
    for (const customCommand of this.settings.lintCommands) {
      if (customCommand.id && customCommand.id.trim() != '') {
        this.hasCustomCommands = true;
        return;
      }
    }

    this.hasCustomCommands = false;
  }

  private endOfDocument(doc: string) {
    const lines = doc.split('\n');
    return {line: lines.length - 1, ch: lines[lines.length - 1].length};
  }

  private async loadCustomReplacements() {
    for (const replacementFileInfo of this.settings.ruleConfigs['auto-correct-common-misspellings']['extra-auto-correct-files'] ?? [] as CustomAutoCorrectContent[]) {
      if (replacementFileInfo.filePath != '') {
        const file = this.getFileFromPath(replacementFileInfo.filePath);
        if (file) {
          replacementFileInfo.customReplacements = parseCustomReplacements(stripCr(await this.app.vault.cachedRead(file)));
        }
      }
    }

    this.hasLoadedFiles = true;
  }

  private getFileFromPath(filePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (file instanceof TFile) {
      return file;
    }

    return null;
  }

  private updateFileDebouncerText(file: TFile, newText: string) {
    if (this.activeFileChangeDebouncer.has(file)) {
      this.activeFileChangeDebouncer.get(file).originalText = newText;
    }
  }
}
