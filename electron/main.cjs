'use strict';

const {app, BrowserWindow, Menu, dialog, session} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

app.setName('BetterGI Combat Editor');
const profile = process.argv.find(value => value.startsWith('--user-data-dir='));
if (profile) app.setPath('userData', path.resolve(profile.slice('--user-data-dir='.length)));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window;
  const command = id => window?.webContents.send('editor:command', id);

  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('io.github.myx144.bettergi-combat-editor');
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (details, callback) => {
      const url = new URL(details.url);
      callback({cancel: !(details.resourceType === 'image' && url.origin === 'https://enka.network'
        && url.pathname.startsWith('/ui/'))});
    });
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({
        title: '保存文件',
        defaultPath: path.join(app.getPath('documents'), path.basename(item.getFilename())),
        filters: [{name: 'JSON', extensions: ['json']}],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });
    });

    window = new BrowserWindow({
      width: 1440, height: 900, minWidth: 760, minHeight: 500,
      title: 'BetterGI Combat Editor', backgroundColor: '#f2f4f7', show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true
      }
    });
    const entry = path.resolve(__dirname, '..', 'index.html');
    const entryUrl = pathToFileURL(entry).href;
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-navigate', (event, destination) => {
      if (destination.split('#')[0] !== entryUrl) event.preventDefault();
    });
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { window = null; });
    window.loadFile(entry);

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label: '文件', submenu: [
        {label: '新建工程', accelerator: 'CmdOrCtrl+N', click: () => command('newProject')},
        {label: '打开工程或战斗 JSON', accelerator: 'CmdOrCtrl+O', click: () => command('importProject')},
        {label: '保存工程', accelerator: 'CmdOrCtrl+S', click: () => command('saveProject')},
        {label: '导出战斗 JSON', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('exportStrategy')},
        {type: 'separator'}, {role: 'quit', label: '退出'}
      ]},
      {label: '视图', submenu: [
        {label: '显示整轮', accelerator: 'CmdOrCtrl+0', click: () => command('fitView')},
        {label: '角色库', click: () => command('libraryToggle')},
        {label: '片段属性', click: () => command('inspectorToggle')},
        {type: 'separator'}, {role: 'togglefullscreen', label: '全屏'}
      ]},
      {label: '帮助', submenu: [
        {label: '关于 BetterGI Combat Editor', click: () => dialog.showMessageBox(window, {
          type: 'info', title: 'BetterGI Combat Editor',
          message: 'BetterGI Combat Editor ' + app.getVersion(),
          detail: '可视化战斗流程与时间轴编辑器\nCopyright (c) 2026 Myx144 and contributors\nMIT License',
          buttons: ['确定']
        })}
      ]}
    ]));
  });
  app.on('window-all-closed', () => app.quit());
}
