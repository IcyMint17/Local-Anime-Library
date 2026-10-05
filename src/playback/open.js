/**
 * Hands a file to the operating system so it opens in whatever player the user
 * has associated with that extension. The tool never plays media itself.
 */
import { spawn } from 'node:child_process';

export function openWithDefaultPlayer(filePath) {
  const options = { detached: true, stdio: 'ignore', windowsHide: true };
  if (process.platform === 'win32') {
    // rundll32 handles spaces and non-ASCII paths far more reliably than
    // `cmd /c start`, which mangles quoting.
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', filePath], options);
    child.on('error', () => {
      const fallback = spawn('cmd', ['/c', 'start', '', filePath], options);
      fallback.unref();
    });
    child.unref();
    return true;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [filePath], options);
  child.unref();
  return true;
}
