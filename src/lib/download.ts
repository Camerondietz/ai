/** Save data as a local file (never uploaded anywhere). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(text: string, filename: string, mime = 'text/plain') {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export function downloadJSON(value: unknown, filename: string) {
  downloadText(JSON.stringify(value, null, 2), filename, 'application/json');
}

export function readFileText(file: Blob): Promise<string> {
  return file.text();
}

/** Open a native file picker and resolve with the chosen files. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
    input.click();
  });
}

/** Open a folder picker; files carry webkitRelativePath ("folder/sub/file"). */
export function pickDirectory(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
    input.click();
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function timestampSlug(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 19).replace(/[:T]/g, '-');
}
