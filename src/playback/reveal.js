/**
 * Opens a folder in the OS file manager. Used by "打开文件夹" in the detail
 * view; the app never moves or renames anything.
 */
import { spawn } from 'node:child_process';

export function openFolder(folderPath) {
  const options = { detached: true, stdio: 'ignore', windowsHide: true };
  const command =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [folderPath], options);
  child.on('error', () => {});
  child.unref();
  return true;
}
