// The right-click menu a browser gives for free: spelling, cut, copy, paste, and copying a link.
import {
  clipboard,
  Menu,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron';

export function attachContextMenu(
  window: BrowserWindow,
  options: { inspect: boolean },
): void {
  const contents = window.webContents;
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    const separate = () => {
      if (items.length && items.at(-1)?.type !== 'separator')
        items.push({ type: 'separator' });
    };

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5))
        items.push({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion),
        });
      if (!params.dictionarySuggestions.length)
        items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({
        label: 'Add to Dictionary',
        click: () =>
          contents.session.addWordToSpellCheckerDictionary(
            params.misspelledWord,
          ),
      });
      separate();
    }

    if (params.linkURL) {
      items.push({
        label: 'Copy Link',
        click: () => clipboard.writeText(params.linkURL),
      });
      separate();
    }

    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' }, { role: 'selectAll' });
    }

    if (params.mediaType === 'image' && params.srcURL) {
      separate();
      items.push({
        label: 'Copy Image',
        click: () => contents.copyImageAt(params.x, params.y),
      });
    }

    if (options.inspect) {
      separate();
      items.push({
        label: 'Inspect',
        click: () => contents.inspectElement(params.x, params.y),
      });
    }

    while (items.at(-1)?.type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });
}
