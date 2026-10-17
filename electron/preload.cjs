'use strict';

const {ipcRenderer} = require('electron');
const commands = new Set(['newProject', 'importProject', 'saveProject', 'exportStrategy',
  'fitView', 'libraryToggle', 'inspectorToggle']);
ipcRenderer.on('editor:command', (_event, id) => {
  if (commands.has(id)) document.getElementById(id)?.click();
});
