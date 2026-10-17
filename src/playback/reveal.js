/**
 * Opens a folder in the OS file manager. Used by "打开文件夹" in the detail
 * view; the app never moves or renames anything.
 *
 * Windows Explorer is a GUI process, so `windowsHide` must stay off — hiding it
 * makes the new window come up behind the browser and looks like nothing
 * happened. If Explorer cannot be spawned, fall back to `start`.
 */
import { spawn } from 'node:child_process';

export function openFolder(folderPath) {
  const options = { detached: true, stdio: 'ignore' };

  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [folderPath], options);
    child.on('error', () => {
      const fallback = spawn('cmd', ['/c', 'start', '', 'explorer.exe', folderPath], options);
      fallback.on('error', () => {});
      fallback.unref();
    });
    child.unref();
    return true;
  }

  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [folderPath], options);
  child.on('error', () => {});
  child.unref();
  return true;
}
